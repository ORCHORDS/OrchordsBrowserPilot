import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Session } from "../src/session.ts";

class FakePage extends EventEmitter {
  closed = false;

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

describe("Session page generations (#104)", () => {
  it("installs listeners on every adopted Page and invalidates refs across replacements", async () => {
    const first = new FakePage();
    const second = new FakePage();
    let active = first;
    const manager = {
      page: async () => active as never,
      close: async () => undefined,
    };
    const session = new Session("page-generation", manager as never);

    await session.page();
    assert.equal(session.pageGeneration(), 1);
    session.refs.ingest("- button \"First\" [ref=e1]", undefined, session.pageGeneration());
    assert.equal(session.refs.size(), 1);

    first.emit("framenavigated", {});
    assert.equal(session.pageGeneration(), 2);
    assert.equal(session.refs.size(), 0);

    session.refs.ingest("- button \"First\" [ref=e2]", undefined, session.pageGeneration());
    first.closed = true;
    active = second;
    await session.page();
    assert.equal(session.pageGeneration(), 3);
    assert.equal(session.refs.size(), 0);

    session.refs.ingest("- button \"Second\" [ref=e3]", undefined, session.pageGeneration());
    second.emit("framenavigated", {});
    assert.equal(session.pageGeneration(), 4);
    assert.equal(session.refs.size(), 0, "replacement Page must have its own navigation listener");
  });
});
