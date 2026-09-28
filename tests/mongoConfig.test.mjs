import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMongoUri, explainMissingMongo } from '../lib/mongoConfig.js';

test('mongo uri: accepts common names, strips quotes/spaces, rejects junk', () => {
  assert.equal(resolveMongoUri({ MONGODB_URI: ' "mongodb+srv://u:p@c.mongodb.net/x" ' }), 'mongodb+srv://u:p@c.mongodb.net/x');
  assert.equal(resolveMongoUri({ MONGO_URI: 'mongodb://h:27017' }), 'mongodb://h:27017');
  assert.equal(resolveMongoUri({ DATABASE_URL: 'postgres://x' }), '');
  assert.equal(resolveMongoUri({}), '');
  assert.match(explainMissingMongo({}), /no MONGODB_URI/);
  assert.match(explainMissingMongo({ MONGODB_URI: 'mongodb+srv://u:<password>@c' }), /<password>/);
});
