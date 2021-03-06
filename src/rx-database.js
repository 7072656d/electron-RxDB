/* eslint global-require: 0 */
import Sqlite3 from 'better-sqlite3';
import PromiseQueue from 'promise-queue';
import {ipcRenderer} from 'electron';
import LRU from 'lru-cache';
import {EventEmitter} from 'events';

import Query from './query';
import {logSQLString} from './console-utils';
import ModelRegistry from './model-registry';
import DatabaseChangeRecord from './database-change-record';
import DatabaseChangeRecordDebouncer from './database-change-record-debouncer';
import QuerySubscriptionPool from './query-subscription-pool';
import DatabaseTransaction from './database-transaction';
import {analyzeQueriesForClass, setupQueriesForClass} from './query-builder';
import JSONBlob from './json-blob';

const DatabasePhase = {
  Setup: 'setup',
  Ready: 'ready',
  Close: 'close',
}

class IncorrectVersionError extends Error {
  constructor({actual, expected}) {
    super(`Incorrect database schema version: ${actual} not ${expected}`);
  }
}
/**
The RxDatabase is the central database object of RxDB. You can instantiate
as many databases as you'd like at the same time, and opening the same
database path in multiple windows is fine - RxDB uses SQLite transactions and
dispatches change events across windows via the Electron IPC module.

This class extends EventEmitter, and you can subscribe to all changes to the
database by subscribing to the `trigger` event.

For more information about getting started with RxDB, see the Getting Started
guide.

@extends EventEmitter
*/

export default class RxDatabase extends EventEmitter {

  static ChangeRecord = DatabaseChangeRecord;
  static IncorrectVersionError = IncorrectVersionError;

  constructor({primary, databasePath, databaseVersion, logQueries, logQueryPlans} = {}) {
    super();

    this.setMaxListeners(100);

    if (!databasePath) {
      throw new Error("RxDatabase: You must provide a SQLite file path.");
    }
    if (!databaseVersion || (typeof databaseVersion !== 'string')) {
      throw new Error("RxDatabase: You must provide a database schema version number.");
    }

    this.models = new ModelRegistry();

    this._options = {primary, databasePath, databaseVersion, logQueries, logQueryPlans};

    this._querySubscriptionPool = new QuerySubscriptionPool(this);
    this._transactionQueue = new PromiseQueue(1, Infinity);
    this._preparedStatementCache = LRU({max: 500});
    this._inflightTransactions = 0;
    this._open = false;
    this._waiting = [];
    this._mutationHooks = [];
    this._debouncer = new DatabaseChangeRecordDebouncer({
      onTrigger: (record) => this.trigger(record),
      maxTriggerDelay: 10,
    })

    // Listen for trigger events originating in other windows
    ipcRenderer.on('rxdb-trigger', this._onIPCTrigger);

    // Listen to events from the application telling us when the database is ready,
    // should be closed so it can be deleted, etc.
    ipcRenderer.on('rxdb-phase-changed', this._onPhaseChanged);
    setTimeout(() => {
      const phase = ipcRenderer.sendSync('rxdb-get-phase');
      this._onPhaseChanged(null, phase);
    }, 0);
  }

  /**
  Typically, instances of RxDatabase are long-lasting and are created in
  renderer processes when they load. If you need to manually tear down an instance
  of RxDatabase, call `disconnect`.
  */
  disconnect() {
    ipcRenderer.removeListener('rxdb-phase-changed', this._onPhaseChanged);
    ipcRenderer.removeListener('rxdb-trigger', this._onIPCTrigger);
  }

  _onIPCTrigger = ({json, path}) => {
    if (path === this._options.databasePath) {
      this.emit('trigger', new DatabaseChangeRecord(this, json));
    }
  }

  _onPhaseChanged = (event, phase) => {
    if (phase === DatabasePhase.Setup) {
      if (!this._options.primary) {
        return;
      }
      this._openDatabase(() => {
        this._checkDatabaseVersion({allowUnset: true}, () => {
          this._runDatabaseSetup(() => {
            ipcRenderer.send('rxdb-set-phase', DatabasePhase.Ready);
            setTimeout(() => this._runDatabaseAnalyze(), 60 * 1000);
          });
        });
      });
    } else if (phase === DatabasePhase.Ready) {
      this._openDatabase(() => {
        this._checkDatabaseVersion({}, () => {
          this._open = true;
          for (const w of this._waiting) {
            w();
          }
          this._waiting = [];
        });
      });
    } else if (phase === DatabasePhase.Close) {
      this._open = false;
      if (this._db) {
        this._db.close();
        this._db = null;
      }
    }
  }

  _openDatabase(ready) {
    if (this._db) {
      ready();
      return;
    }

    this._db = new Sqlite3(this._options.databasePath, {});

    this._db.on('close', (err) => {
      this._handleSetupError(err);
    })

    this._db.on('open', () => {
      // Note: These are properties of the connection, so they must be set regardless
      // of whether the database setup queries are run.

      // https://www.sqlite.org/wal.html
      // WAL provides more concurrency as readers do not block writers and a writer
      // does not block readers. Reading and writing can proceed concurrently.
      this._db.pragma(`journal_mode = WAL`);

      // https://www.sqlite.org/intern-v-extern-blob.html
      // A database page size of 8192 or 16384 gives the best performance for large BLOB I/O.
      this._db.pragma(`main.page_size = 8192`);
      this._db.pragma(`main.cache_size = 20000`);
      this._db.pragma(`main.synchronous = NORMAL`);

      ready();
    });
  }

  _checkDatabaseVersion({allowUnset} = {}, ready) {
    const result = this._db.pragma('user_version', true);
    const isUnsetVersion = (result === '0');
    const isWrongVersion = (result !== this._options.databaseVersion);
    if (isWrongVersion && !(isUnsetVersion && allowUnset)) {
      return this._handleSetupError(new IncorrectVersionError({
        actual: result,
        expected: this._options.databaseVersion,
      }));
    }
    return ready();
  }

  _runDatabaseSetup(ready) {
    try {
      for (const klass of this.models.getAllConstructors()) {
        const queries = setupQueriesForClass(klass);

        // setup search index objects that actually maintain the FTS5 tables
        Object.keys(klass.searchIndexes).forEach((name) => {
          const searchIndex = klass.searchIndexes[name];
          queries.push(searchIndex.tableCreateQuery());
        });

        // run queries to create tables and indexes
        for (const query of queries) {
          if (this._options.logQueries) {
            console.log(`RxDatabase: ${query}`);
          }
          this._db.prepare(query).run();
        }

        // activate search indexes
        Object.keys(klass.searchIndexes).forEach((name) => {
          klass.searchIndexes[name].activate(this, klass, name);
        });
      }
    } catch (err) {
      return this._handleSetupError(err);
    }

    this._db.pragma(`user_version=${this._options.databaseVersion}`);

    /**
    @event RxDatabase#did-setup-database
    @type {object}
    @property {object} sqlite - The underlying SQLite3 database instance.
    */
    this.emit('did-setup-database', {sqlite: this._db});

    return ready();
  }

  _runDatabaseAnalyze() {
    const queries = [];
    for (const klass of this.models.getAllConstructors()) {
      queries.push(...analyzeQueriesForClass(klass))
    }

    const step = () => {
      const query = queries.shift();
      if (query) {
        if (this._options.logQueries) {
          console.log(`RxDatabase: ${query}`);
        }
        this._db.prepare(query).run();
        setTimeout(step, 100);
      } else {
        console.log(`Completed ANALYZE of database`);
      }
    }
    step();
  }

  _handleSetupError(error = (new Error(`Manually called _handleSetupError`))) {
    /**
    @event RxDatabase#will-rebuild-database
    @type {object}
    @property {object} sqlite - The underlying SQLite3 database instance.
    @property {Error} error - The error that occurred.
    */
    this.emit('will-rebuild-database', {sqlite: this._db, error: error});
    ipcRenderer.sendSync('rxdb-handle-setup-error');
  }

  /**
  Executes a SQL string on the database. If a query is made before the database
  has been opened, the query will be held in a queue and run / resolved when
  the database is ready.

  @protected

  @param {String} query - A SQLite SQL string
  @param {Array} values - An array of values, corresponding to `?` in the SQL string.
  @returns {Promise} - Resolves when the query has been completed and rejects when
    the query has failed.
  */
  _query(query, values = []) {
    return new Promise((resolve, reject) => {
      if (!this._open) {
        this._waiting.push(() => this._query(query, values).then(resolve, reject));
        return;
      }

      // Undefined, True, and False are not valid SQLite datatypes:
      // https://www.sqlite.org/datatype3.html
      values.forEach((val, idx) => {
        if (val === false) {
          values[idx] = 0;
        } else if (val === true) {
          values[idx] = 1;
        } else if (val === undefined) {
          values[idx] = null;
        }
      });

      if (query.startsWith(`SELECT `) && this._options.logQueryPlans) {
        const plan = this._db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(values);
        const planString = `${plan.map(row => row.detail).join('\n')} for ${query}`;
        if (planString.includes('ThreadCounts')) {
          return;
        }
        if (planString.includes('ThreadSearch')) {
          return;
        }
        if (planString.includes('SCAN') && !planString.includes('COVERING INDEX')) {
          logSQLString(planString);
        }
      }

      if (query.startsWith(`BEGIN`)) {
        if (this._inflightTransactions !== 0) {
          throw new Error("Assertion Failure: BEGIN called when an existing transaction is in-flight. Use inTransaction() to aquire transactions.")
        }
        this._inflightTransactions += 1;
      }

      const fn = query.startsWith('SELECT') ? 'all' : 'run';
      let tries = 0;
      let results = null;

      // Because other processes may be writing to the database and modifying the
      // schema (running ANALYZE, etc.), we may `prepare` a statement and then be
      // unable to execute it. Handle this case silently unless it's persistent.
      while (!results) {
        try {
          let stmt = this._preparedStatementCache.get(query);
          if (!stmt) {
            stmt = this._db.prepare(query);
            this._preparedStatementCache.set(query, stmt)
          }
          results = stmt[fn](values);
        } catch (err) {
          if (tries < 3 && err.toString().includes('database schema has changed')) {
            this._preparedStatementCache.del(query);
            tries += 1;
          } else {
            // note: this function may throw a promise, which causes our Promise to reject
            throw new Error(`RxDatabase: Query ${query}, ${JSON.stringify(values)} failed ${err.toString()}`);
          }
        }
      }

      if (query === 'COMMIT') {
        this._inflightTransactions -= 1;
        if (this._inflightTransactions < 0) {
          this._inflightTransactions = 0;
          throw new Error("Assertion Failure: COMMIT was called too many times and the transaction count went negative.")
        }
      }

      resolve(results);
    });
  }

  // PUBLIC METHODS #############################

  // ActiveRecord-style Querying

  /**
  Creates a new Query for retrieving a single model specified by
  the class and id.

  @param {Model} klass - The class of the {Model} you're trying to retrieve.
  @param {String} id - The id of the {Model} you're trying to retrieve

  Example:

  ```js
  db.find(Thread, 'id-123').then((thread) => {
    // thread is a Thread object, or null if no match was found.
  });
  ```

  @returns {Query}
  */
  find(klass, id) {
    if (!klass) {
      throw new Error(`RxDatabase::find - You must provide a class`);
    }
    if (typeof id !== 'string') {
      throw new Error(`RxDatabase::find - You must provide a string id. You may have intended to use findBy.`);
    }
    return new Query(klass, this).where({id}).one();
  }

  /**
  Creates a new Model Query for retrieving a single model matching the
  predicates provided.

  @param {Model} klass - The class of the {Model} you're trying to retrieve.
  @param {Matcher[]} predicates - the set of predicates the returned model must match.

  @returns {Query}
  */
  findBy(klass, predicates = []) {
    if (!klass) {
      throw new Error(`RxDatabase::findBy - You must provide a class`);
    }
    return new Query(klass, this).where(predicates).one();
  }

  /**
  Creates a new Model Query for retrieving all models matching the
  predicates provided.

  @param {Model} klass - The class you're trying to retrieve.
  @param {Matcher[]} predicates - An array of matcher objects. The set of
    predicates the returned model must match.

  @returns {Query}
  */
  findAll(klass, predicates = []) {
    if (!klass) {
      throw new Error(`RxDatabase::findAll - You must provide a class`);
    }
    return new Query(klass, this).where(predicates);
  }

  /**
  Creates a new Query that returns the number of models matching
  the predicates provided.

  @param {Model} klass - The Model class you're trying to retrieve.
  @param {Matcher[]} predicates - The set of predicates the returned model
  must match.

  @returns {Query}
  */
  count(klass, predicates = []) {
    if (!klass) {
      throw new Error(`RxDatabase::count - You must provide a class`);
    }
    return new Query(klass, this).where(predicates).count();
  }

  /**
  Modelify takes a mixed array of model IDs or model instances, and
  queries for items that are missing. The returned array contains just model
  instances, or null if the model could not be found.

  This function is useful if your code may receive an item or it's ID.

  Modelify is efficient and uses a single database query. It resolves Immediately
  if no query is necessary. It does not change the order of items in the array.

  @param {Model} klass - The model class desired
  @param {Array} arr - An {Array} with a mix of string model IDs and/or models.

  @returns {Promise} - A promise that resolves with the models.
  */
  modelify(klass, arr) {
    if (!(arr instanceof Array) || (arr.length === 0)) {
      return Promise.resolve([]);
    }

    const ids = []
    for (const item of arr) {
      if (item instanceof klass) {
        ids.push(item.id);
      } else if (typeof item === 'string') {
        ids.push(item);
      } else {
        throw new Error(`modelify: Not sure how to convert ${item} into a ${klass.name}`);
      }
    }
    if ((ids.length === 0) && (ids.length === 0)) {
      return Promise.resolve(arr);
    }

    return this.findAll(klass).where(klass.attributes.id.in(ids)).then((modelsFromIds) => {
      const modelsByString = {};
      for (const model of modelsFromIds) {
        modelsByString[model.id] = model;
      }
      return Promise.resolve(arr.map(item =>
        (item instanceof klass ? item : modelsByString[item]))
      );
    });
  }

  /**
  Executes a model {Query} on the local database. Typically, this method is
  called transparently and you do not need to invoke it directly.

  @protected

  @param {Query} modelQuery - The query to execute.
  @param {Object} options
  @param {Boolean} options.format - Pass `format: true` to transform the result
    into a set of models. Defaults to true.
  @returns {Promise} - A promise that resolves with the result of the database query.
  */
  run(modelQuery, options = {format: true}) {
    return this._query(modelQuery.sql(), []).then((result) => {
      let transformed = modelQuery.inflateResult(result);
      if (options.format !== false) {
        transformed = modelQuery.formatResult(transformed)
      }
      return Promise.resolve(transformed);
    });
  }

  findJSONBlob(id) {
    return new JSONBlob.Query(JSONBlob, this).where({id}).one();
  }

  /**
  Mutation hooks allow you to observe changes to the database and
  add functionality within the transaction, before and/or after the standard
  REPLACE / INSERT queries are made.

   - beforeDatabaseChange: Run queries, etc. and return a promise. The RxDatabase
     will proceed with changes once your promise has finished. You cannot call
     persistModel or unpersistModel from this hook. Instead, use low level calls
     like RxDatabase._query.

   - afterDatabaseChange: Run queries, etc. after the `REPLACE` / `INSERT` queries

  Warning: this is very low level. If you just want to watch for changes, You
  should subscribe to the RxDatabase's trigger events.

  Example: N1 uses these hooks to watch for changes to unread counts, which are
  maintained in a separate table to avoid frequent `COUNT(*)` queries.
  */
  addMutationHook({beforeDatabaseChange, afterDatabaseChange}) {
    if (!beforeDatabaseChange) {
      throw new Error(`RxDatabase:addMutationHook - You must provide a beforeDatabaseChange function`);
    }
    if (!afterDatabaseChange) {
      throw new Error(`RxDatabase:addMutationHook - You must provide a afterDatabaseChange function`);
    }
    this._mutationHooks.push({beforeDatabaseChange, afterDatabaseChange});
  }

  /**
  Removes a previously registered mutation hook. You must pass the exact
  same object that was provided to {RxDatabase.addMutationHook}.
  */
  removeMutationHook(hook) {
    this._mutationHooks = this._mutationHooks.filter(h => h !== hook);
  }

  /**
  @returns currently registered mutation hooks
  */
  mutationHooks() {
    return this._mutationHooks;
  }


  /**
  Opens a new database transaction and executes the provided `fn` within the
  transaction. After the transaction function resolves, the transaction is
  closed and changes are relayed to live queries and other subscribers.

  RxDB makes the following guaruntees:

  - Serial Execution: Once started, no other calls to `inTransaction` will
    excute until the promise returned by `fn` has finished.

  - Single Process Writing: No other process will be able to write to the
    database while the provided function is running. RxDB uses SQLite's
    `BEGIN IMMEDIATE TRANSACTION`, with the following semantics:
      + No other connection will be able to write any changes.
      + Other connections can read from the database, but they will not see
        pending changes.

  @param {Function} fn - A callback that will be executed inside a database
    transaction

  @returns {Promise} - A promise that resolves when the transaction has
    successfully completed.

  @emits RxDatabase#trigger
  **/
  inTransaction(fn) {
    return this._transactionQueue.add(() =>
      new DatabaseTransaction(this).execute(fn)
    );
  }

  /**
  @protected
  */
  transactionDidCommitChanges(changeRecords) {
    for (const record of changeRecords) {
      this._debouncer.accumulate(record);
    }
  }

  // Compatibility with Reflux / Flux Stores

  /**
  For compatibility with Reflux, Flux and other libraries, you can subscribe to
  the database using `listen`:

  ```js
  componentDidMount() {
    this._unsubscribe = db.listen(this._onDataChanged, this);
  }
  ```

  @param {Function} callback - The function to execute when the database triggers.
  @param {Object} [bindContext] - Optional binding for `callback`.
  */
  listen(callback, bindContext = this) {
    if (!callback) {
      throw new Error("RxDatabase.listen called with undefined callback");
    }
    let aborted = false
    const eventHandler = (...args) => {
      if (aborted) { return }
      callback.apply(bindContext, args);
    }
    this.addListener('trigger', eventHandler);
    return () => {
      aborted = true;
      this.removeListener('trigger', eventHandler);
    }
  }

  /**
  @protected
  */
  trigger(record) {
    ipcRenderer.send('rxdb-trigger', {
      path: this._options.databasePath,
      json: record.toJSON(),
    });
    /**
    @event RxDatabase#trigger
    @type {DatabaseChangeRecord}
    */
    this.emit('trigger', record);
  }
}
