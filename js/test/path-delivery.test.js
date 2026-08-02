import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleCreditDeliveryBuffer,
  normalizePathInvalidations,
} from "../path-delivery.js";

test("early delivery waits for the physical output namespace", () => {
  const lexicalAlias = "/workspace/alias";
  const physicalRoot = Buffer.from([0x2f, 0x77, 0x6f, 0x72, 0x6b, 0x2f, 0xff]);
  const exactChild = Buffer.concat([physicalRoot, Buffer.from("/changed"), Buffer.from([0xfe])]);
  const delivered = [];
  const abandoned = [];
  let outputRoot = lexicalAlias;
  const buffer = createSingleCreditDeliveryBuffer({
    deliver(batch, deliveryId) {
      delivered.push({
        deliveryId,
        paths: normalizePathInvalidations(outputRoot, batch.invalidatedPaths),
      });
    },
    abandon(_batch, deliveryId) {
      abandoned.push(deliveryId);
    },
  });

  buffer.accept({ invalidatedPaths: [exactChild] }, 1n);
  assert.deepEqual(delivered, []);
  outputRoot = null;
  buffer.ready();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].deliveryId, 1n);
  assert.equal(delivered[0].paths.pathEncoding, "bytes-only");
  assert.equal(delivered[0].paths.pathEncodingCollapsed, true);
  assert.deepEqual(delivered[0].paths.invalidatedPaths, []);
  assert.ok(Buffer.from(delivered[0].paths.invalidatedPathBytes[0]).equals(exactChild));
  assert.ok(!delivered[0].paths.invalidatedPaths.includes(lexicalAlias));
  assert.deepEqual(abandoned, []);
});

test("the establishment buffer remains single-credit and closes pending delivery", () => {
  const delivered = [];
  const abandoned = [];
  const buffer = createSingleCreditDeliveryBuffer({
    deliver(_batch, deliveryId) {
      delivered.push(deliveryId);
    },
    abandon(_batch, deliveryId) {
      abandoned.push(deliveryId);
    },
  });

  buffer.accept({}, 1n);
  buffer.accept({}, 2n);
  assert.deepEqual(abandoned, [2n]);
  buffer.close();
  buffer.close();
  buffer.accept({}, 3n);
  assert.deepEqual(delivered, []);
  assert.deepEqual(abandoned, [2n, 1n, 3n]);
});
