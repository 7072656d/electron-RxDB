/* eslint dot-notation:0 */
import TestModel from './fixtures/db-test-model';
import Category from './fixtures/category';
import DatabaseTransaction from '../lib/database-transaction';
import DatabaseChangeRecord from '../lib/database-change-record';

const testModelInstance = new TestModel({id: "1234"});
const testModelInstanceA = new TestModel({id: "AAA"});
const testModelInstanceB = new TestModel({id: "BBB"});

function __range__(left, right, inclusive) {
  const range = [];
  const ascending = left < right;
  const incr = ascending ? right + 1 : right - 1;
  const end = !inclusive ? right : incr;
  for (let i = left; ascending ? i < end : i > end; ascending ? i++ : i--) {
    range.push(i);
  }
  return range;
}

describe("DatabaseTransaction", function DatabaseTransactionSpecs() {
  beforeEach(() => {
    this.databaseMutationHooks = [];
    this.performed = [];
    this.database = {
      _query: jasmine.createSpy('database._query').and.callFake((query, values = []) => {
        this.performed.push({query, values});
        return Promise.resolve([]);
      }),
      transactionDidCommitChanges: jasmine.createSpy('database.transactionDidCommitChanges'),
      mutationHooks: () => this.databaseMutationHooks,
    };

    this.transaction = new DatabaseTransaction(this.database);

    jasmine.clock().install();
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  describe("execute", () => {});

  describe("persistModel", () => {
    it("should throw an exception if the model is not a subclass of Model", () =>
      expect(() => this.transaction.persistModel({id: 'asd', subject: 'bla'})).toThrow()
    );

    it("should call through to persistModels", () => {
      spyOn(this.transaction, 'persistModels').and.returnValue(Promise.resolve());
      this.transaction.persistModel(testModelInstance);
      jasmine.clock().tick();
      expect(this.transaction.persistModels.calls.count()).toBe(1);
    });
  });

  describe("persistModels", () => {
    it("should call transactionDidCommitChanges with a change that contains the models", (done) => {
      this.transaction.execute(t => {
        return t.persistModels([testModelInstanceA, testModelInstanceB]);
      });

      jasmine.waitFor(() =>
        this.database.transactionDidCommitChanges.calls.count() > 0
      )
      .then(() => {
        const change = this.database.transactionDidCommitChanges.calls.first().args[0];
        expect(change).toEqual([new DatabaseChangeRecord({
          objectClass: TestModel.name,
          objectIds: [testModelInstanceA.id, testModelInstanceB.id],
          objects: [testModelInstanceA, testModelInstanceB],
          type: 'persist',
        })]);
        done();
      });
    });

    it("should call through to _writeModels after checking them", (done) => {
      spyOn(this.transaction, '_writeModels').and.returnValue(Promise.resolve());
      this.transaction.persistModels([testModelInstanceA, testModelInstanceB]);
      jasmine.waitFor(() => this.transaction._writeModels.calls.count() > 0).then(() => {
        expect(this.transaction._writeModels.calls.count()).toBe(1)
        done()
      });
    });

    it("should throw an exception if the models are not the same class, since it cannot be specified by the trigger payload", () =>
      expect(() => this.transaction.persistModels([testModelInstanceA, new Category()])).toThrow()
    );

    it("should throw an exception if the models are not a subclass of Model", () =>
      expect(() => this.transaction.persistModels([{id: 'asd', subject: 'bla'}])).toThrow()
    );

    describe("mutationHooks", () => {
      beforeEach(() => {
        this.beforeShouldThrow = false;
        this.beforeShouldReject = false;

        this.hook = {
          beforeDatabaseChange: jasmine.createSpy('beforeDatabaseChange').and.callFake(() => {
            if (this.beforeShouldThrow) { throw new Error("beforeShouldThrow"); }
            return new Promise((resolve) => {
              setTimeout(() => {
                if (this.beforeShouldReject) { resolve(new Error("beforeShouldReject")); }
                resolve("value");
              }
              , 1000);
            });
          }),
          afterDatabaseChange: jasmine.createSpy('afterDatabaseChange').and.callFake(() => {
            return new Promise((resolve) => setTimeout(() => resolve(), 1000));
          }),
        };

        this.databaseMutationHooks.push(this.hook);

        this.writeModelsResolve = null;
        spyOn(this.transaction, '_writeModels').and.callFake(() => {
          return new Promise((resolve) => {
            this.writeModelsResolve = resolve;
          });
        });
      });

      it("should run pre-mutation hooks, wait to write models, and then run post-mutation hooks", (done) => {
        this.transaction.persistModels([testModelInstanceA, testModelInstanceB]);

        expect(this.hook.beforeDatabaseChange).toHaveBeenCalledWith(
          this.transaction._query,
          {
            objects: [testModelInstanceA, testModelInstanceB],
            objectIds: [testModelInstanceA.id, testModelInstanceB.id],
            objectClass: testModelInstanceA.constructor.name,
            type: 'persist',
          },
          undefined
        );
        expect(this.transaction._writeModels).not.toHaveBeenCalled();
        jasmine.clock().tick(1000);
        jasmine.waitFor(() => this.transaction._writeModels.calls.count() > 0).then(() => {
          expect(this.hook.afterDatabaseChange).not.toHaveBeenCalled();
          this.writeModelsResolve();

          jasmine.waitFor(() => this.hook.afterDatabaseChange.calls.count() > 0).then(() => {
            expect(this.hook.afterDatabaseChange).toHaveBeenCalledWith(
              this.transaction._query,
              {
                objects: [testModelInstanceA, testModelInstanceB],
                objectIds: [testModelInstanceA.id, testModelInstanceB.id],
                objectClass: testModelInstanceA.constructor.name,
                type: 'persist',
              },
              "value"
            );
            done();
          });
        });
      });

      it("should carry on if a pre-mutation hook throws", (done) => {
        this.beforeShouldThrow = true;
        this.transaction.persistModels([testModelInstanceA, testModelInstanceB]);
        jasmine.clock().tick(1000);
        expect(this.hook.beforeDatabaseChange).toHaveBeenCalled();
        jasmine.waitFor(() => this.transaction._writeModels.calls.count() > 0).then(done);
      });

      it("should carry on if a pre-mutation hook rejects", (done) => {
        this.beforeShouldReject = true;
        this.transaction.persistModels([testModelInstanceA, testModelInstanceB]);
        jasmine.clock().tick(1000);
        expect(this.hook.beforeDatabaseChange).toHaveBeenCalled();
        jasmine.waitFor(() => this.transaction._writeModels.calls.count() > 0).then(done);
      });
    });
  });

  describe("unpersistModel", () => {
    it("should delete the model by id", (done) =>
      this.transaction.execute(() => {
        return this.transaction.unpersistModel(testModelInstance);
      })
      .then(() => {
        expect(this.performed.length).toBe(3);
        expect(this.performed[0].query).toBe("BEGIN IMMEDIATE TRANSACTION");
        expect(this.performed[1].query).toBe("DELETE FROM `TestModel` WHERE `id` = ?");
        expect(this.performed[1].values[0]).toBe('1234');
        expect(this.performed[2].query).toBe("COMMIT");
        done();
      })
    );

    it("should call transactionDidCommitChanges with a change that contains the model", (done) => {
      this.transaction.execute(() => {
        return this.transaction.unpersistModel(testModelInstance);
      });
      jasmine.waitFor(() =>
        this.database.transactionDidCommitChanges.calls.count() > 0
      ).then(() => {
        const change = this.database.transactionDidCommitChanges.calls.first().args[0];
        expect(change).toEqual([new DatabaseChangeRecord({
          objectClass: TestModel.name,
          objectIds: [testModelInstance.id],
          objects: [testModelInstance],
          type: 'unpersist',
        })]);
        done();
      });
    });

    describe("when the model has collection attributes", () =>
      it("should delete all of the elements in the join tables", (done) => {
        TestModel.configureWithCollectionAttribute();
        this.transaction.execute(t => {
          return t.unpersistModel(testModelInstance);
        })
        .then(() => {
          expect(this.performed.length).toBe(4);
          expect(this.performed[0].query).toBe("BEGIN IMMEDIATE TRANSACTION");
          expect(this.performed[2].query).toBe("DELETE FROM `TestModelCategory` WHERE `id` = ?");
          expect(this.performed[2].values[0]).toBe('1234');
          expect(this.performed[3].query).toBe("COMMIT");
          done();
        });
      })

    );

    describe("when the model has joined data attributes", () =>
      it("should delete the element in the joined data table", (done) => {
        TestModel.configureWithJoinedDataAttribute();
        this.transaction.execute(t => {
          return t.unpersistModel(testModelInstance);
        })
        .then(() => {
          expect(this.performed.length).toBe(4);
          expect(this.performed[0].query).toBe("BEGIN IMMEDIATE TRANSACTION");
          expect(this.performed[2].query).toBe("DELETE FROM `TestModelBody` WHERE `id` = ?");
          expect(this.performed[2].values[0]).toBe('1234');
          expect(this.performed[3].query).toBe("COMMIT");
          done();
        });
      })

    );
  });

  describe("_writeModels", () => {
    it("should compose a REPLACE INTO query to save the model", () => {
      TestModel.configureWithCollectionAttribute();
      this.transaction._writeModels([testModelInstance]);
      expect(this.performed[0].query).toBe("REPLACE INTO `TestModel` (id,data,other) VALUES (?,?,?)");
    });

    it("should save the model JSON into the data column", () => {
      this.transaction._writeModels([testModelInstance]);
      expect(this.performed[0].values[1]).toEqual(JSON.stringify(testModelInstance));
    });

    describe("when the model defines additional queryable attributes", () => {
      beforeEach(() => {
        TestModel.configureWithAllAttributes();
        this.m = new TestModel({
          'id': 'local-6806434c-b0cd',
          'datetime': new Date(),
          'string': 'hello world',
          'boolean': true,
          'number': 15,
        });
      });

      it("should populate additional columns defined by the attributes", () => {
        this.transaction._writeModels([this.m]);
        expect(this.performed[0].query).toBe("REPLACE INTO `TestModel` (id,data,datetime,string-json-key,boolean,number) VALUES (?,?,?,?,?,?)");
      });

      it("should use the JSON-form values of the queryable attributes", () => {
        const json = this.m.toJSON();
        this.transaction._writeModels([this.m]);

        const { values } = this.performed[0];
        expect(values[2]).toEqual(json['datetime']);
        expect(values[3]).toEqual(json['string-json-key']);
        expect(values[4]).toEqual(json['boolean']);
        expect(values[5]).toEqual(json['number']);
      });
    });

    describe("when the model has collection attributes", () => {
      beforeEach(() => {
        TestModel.configureWithCollectionAttribute();
        this.m = new TestModel({id: 'local-6806434c-b0cd', other: 'other'});
        this.m.categories = [new Category({id: 'a'}), new Category({id: 'b'})];
        this.transaction._writeModels([this.m]);
      });

      it("should delete all association records for the model from join tables", () => {
        expect(this.performed[1].query).toBe('DELETE FROM `TestModelCategory` WHERE `id` IN (\'local-6806434c-b0cd\')');
      });

      it("should insert new association records into join tables in a single query, and include queryableBy columns", () => {
        expect(this.performed[2].query).toBe('INSERT OR IGNORE INTO `TestModelCategory` (`id`,`value`,`other`) VALUES (?,?,?),(?,?,?)');
        expect(this.performed[2].values).toEqual(['local-6806434c-b0cd', 'a', 'other', 'local-6806434c-b0cd', 'b', 'other']);
      });
    });

    describe("model collection attributes query building", () => {
      beforeEach(() => {
        TestModel.configureWithCollectionAttribute();
        this.m = new TestModel({id: 'local-6806434c-b0cd', other: 'other'});
        this.m.categories = [];
      });

      it("should page association records into multiple queries correctly", () => {
        const iterable = __range__(0, 199, true);
        for (let j = 0; j < iterable.length; j++) {
          const i = iterable[j];
          this.m.categories.push(new Category({id: `id-${i}`}));
        }
        this.transaction._writeModels([this.m]);

        const collectionAttributeQueries = this.performed.filter(i => i.query.indexOf('INSERT OR IGNORE INTO `TestModelCategory`') === 0
        );

        expect(collectionAttributeQueries.length).toBe(1);
        expect(collectionAttributeQueries[0].values[(200 * 3) - 2]).toEqual('id-199');
      });

      it("should page association records into multiple queries correctly", () => {
        const iterable = __range__(0, 200, true);
        for (let j = 0; j < iterable.length; j++) {
          const i = iterable[j];
          this.m.categories.push(new Category({id: `id-${i}`}));
        }
        this.transaction._writeModels([this.m]);

        const collectionAttributeQueries = this.performed.filter(i => i.query.indexOf('INSERT OR IGNORE INTO `TestModelCategory`') === 0
        );

        expect(collectionAttributeQueries.length).toBe(2);
        expect(collectionAttributeQueries[0].values[(200 * 3) - 2]).toEqual('id-199');
        expect(collectionAttributeQueries[1].values[1]).toEqual('id-200');
      });

      it("should page association records into multiple queries correctly", () => {
        const iterable = __range__(0, 201, true);
        for (let j = 0; j < iterable.length; j++) {
          const i = iterable[j];
          this.m.categories.push(new Category({id: `id-${i}`}));
        }
        this.transaction._writeModels([this.m]);

        const collectionAttributeQueries = this.performed.filter(i => i.query.indexOf('INSERT OR IGNORE INTO `TestModelCategory`') === 0
        );

        expect(collectionAttributeQueries.length).toBe(2);
        expect(collectionAttributeQueries[0].values[(200 * 3) - 2]).toEqual('id-199');
        expect(collectionAttributeQueries[1].values[1]).toEqual('id-200');
        expect(collectionAttributeQueries[1].values[4]).toEqual('id-201');
      });
    });

    describe("when the model has joined data attributes", () => {
      beforeEach(() => TestModel.configureWithJoinedDataAttribute());

      it("should not include the value to the joined attribute in the JSON written to the main model table", () => {
        this.m = new TestModel({id: 'local-6806434c-b0cd', body: 'hello world'});
        this.transaction._writeModels([this.m]);
        expect(this.performed[0].values).toEqual(['local-6806434c-b0cd', '{"id":"local-6806434c-b0cd"}']);
      });

      it("should write the value to the joined table if it is defined", () => {
        this.m = new TestModel({id: 'local-6806434c-b0cd', body: 'hello world'});
        this.transaction._writeModels([this.m]);
        expect(this.performed[1].query).toBe('REPLACE INTO `TestModelBody` (`id`, `value`) VALUES (?, ?)');
        expect(this.performed[1].values).toEqual([this.m.id, this.m.body]);
      });

      it("should not write the value to the joined table if it undefined", () => {
        this.m = new TestModel({id: 'local-6806434c-b0cd'});
        this.transaction._writeModels([this.m]);
        expect(this.performed.length).toBe(1);
      });
    });
  });
});
