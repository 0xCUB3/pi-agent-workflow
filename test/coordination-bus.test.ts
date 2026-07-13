import test from "node:test";
import assert from "node:assert/strict";
import { CoordinationBus } from "../src/coordination-bus.js";

test("coordination bus publishes ids, filters inbox, peeks, and waits", async () => {
  const bus = new CoordinationBus();
  const first = bus.publish({ from: "a", to: "b", body: "one" }).message;
  const second = bus.publish({ from: "c", to: "b", body: "two", replyTo: first.id }).message;
  assert.match(first.id, /^m/);
  assert.equal(bus.unread("b"), 2);
  assert.deepEqual(bus.inbox("b", { from: "c", peek: true }), [second]);
  assert.equal(bus.unread("b"), 2);
  assert.deepEqual(bus.inbox("b", { from: "a" }), [first]);
  assert.equal(bus.unread("b"), 1);
  const waited = bus.wait("b", { from: "d", timeoutMs: 1000 });
  setTimeout(() => bus.publish({ from: "d", to: "b", body: "reply" }), 5);
  assert.equal((await waited)?.body, "reply");
});

test("coordination bus aborts waits without retaining a waiter", async () => {
  const bus = new CoordinationBus();
  const controller = new AbortController();
  const waiting = bus.wait("b", { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  assert.equal(await waiting, undefined);
  bus.publish({ from: "a", to: "b", body: "later" });
  assert.equal(bus.unread("b"), 1);
});