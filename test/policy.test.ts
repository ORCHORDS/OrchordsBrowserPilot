import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ActionGate,
  ApprovalStore,
  MemoryAuditSink,
  canonicalizeEnvelope,
  classifyRisk,
  combineRisk,
  digestEnvelope,
  fingerprintElement,
  originFromUrl,
  summarizeEnvelope,
  type LiveStateSnapshot,
  type ProposedActionEnvelope,
} from "../src/policy/index.ts";

/**
 * The acceptance criteria for issue #81 are spelled out in the issue
 * body and the second comment from benrrr56-wq. The tests below cover:
 *
 *   1. Canonical envelopes are byte-deterministic regardless of how the
 *      caller built them.
 *   2. The envelope digest is bound to the exact tool, target, args,
 *      origin, and preconditions.
 *   3. Risk classification produces the maximum across tool / origin /
 *      form / argument signals.
 *   4. Approvals are one-time use; replay is rejected.
 *   5. A modified envelope between proposal and dispatch fails the gate
 *      (TOCTOU).
 *   6. Silent risk downgrades are rejected.
 *   7. Secret-version drift between approval and dispatch invalidates the
 *      approval.
 *   8. Approvals cannot be minted as blanket grants; every approval is
 *      bound to a specific envelope digest + nonce.
 *   9. The audit log records proposal, approval, and dispatch events.
 *  10. Tool calls denied by policy never run the handler.
 */

function makeEnvelope(over: Partial<ProposedActionEnvelope> = {}): ProposedActionEnvelope {
  return {
    version: 1,
    proposalId: "p-test",
    tool: "browser_click",
    sessionId: "s-1",
    pageUrl: "https://example.com/page",
    frameUrl: "https://example.com/page",
    effectiveUrl: "https://example.com/page",
    origin: "https://example.com",
    target: { kind: "selector", selector: "button.submit" },
    arguments: { selector: "button.submit" },
    secrets: [],
    riskClass: "sensitive",
    preconditions: [{ kind: "page.url", digest: "11111111", note: "https://example.com/page" }],
    proposedAt: 1700000000000,
    ...over,
  };
}

function live(over: Partial<LiveStateSnapshot> = {}): LiveStateSnapshot {
  return {
    pageUrl: "https://example.com/page",
    frameUrl: "https://example.com/page",
    effectiveUrl: "https://example.com/page",
    origin: "https://example.com",
    liveSecretVersions: {},
    ...over,
  };
}

function makeGate(
  opts: { audit?: MemoryAuditSink; policy?: import("../src/policy/gate.ts").GatePolicy; ttl?: number } = {},
) {
  const audit = opts.audit ?? new MemoryAuditSink();
  const approvals = new ApprovalStore();
  const policy = opts.policy ?? {
    requireApprovalFor: (r: import("../src/policy/envelope.ts").RiskClass) =>
      r === "sensitive" || r === "irreversible",
    approvalTtlMs: opts.ttl ?? 60_000,
  };
  const gate = new ActionGate(approvals, audit.asSink(), policy);
  return { gate, approvals, audit };
}

/**
 * Drive the propose → gate flow the same way the server does: propose
 * once (which mints a proposalId + envelope digest), then call gate
 * with that proposal. The two calls share the same proposalId, so the
 * TOCTOU check on the same live state succeeds.
 */
function proposeAndGate(gate: ActionGate, inputs: import("../src/policy/gate.ts").GateInputs) {
  const proposal = gate.propose(inputs);
  if (!proposal) throw new Error("propose returned undefined");
  return gate.gate({
    ...inputs,
    proposal: proposal.envelope,
    proposalEnvelopeDigest: proposal.envelopeDigest,
  });
}

describe("policy canonicalization (#81)", () => {
  it("produces byte-deterministic output regardless of key order", () => {
    const a = makeEnvelope({
      arguments: { text: "hello", ref: "e5" },
      secrets: [{ id: "s1", version: 2, versionHash: "ab".repeat(32) }],
    });
    // Construct b with arguments in reversed order to prove the canonicalizer
    // is order-insensitive. Both envelopes must end up with the same digest.
    const b = makeEnvelope({
      arguments: { ref: "e5", text: "hello" },
      secrets: [{ id: "s1", version: 2, versionHash: "ab".repeat(32) }],
    });
    // Simulate a different caller that builds the same logical envelope in a
    // different key order: serialize as canonical JSON, then re-parse and rebuild.
    const reParsed = JSON.parse(JSON.stringify(a)) as ProposedActionEnvelope;
    // Shuffle the top-level keys
    const shuffled = {
      proposedAt: reParsed.proposedAt,
      preconditions: reParsed.preconditions,
      secrets: reParsed.secrets,
      arguments: reParsed.arguments,
      target: reParsed.target,
      origin: reParsed.origin,
      effectiveUrl: reParsed.effectiveUrl,
      frameUrl: reParsed.frameUrl,
      pageUrl: reParsed.pageUrl,
      sessionId: reParsed.sessionId,
      tool: reParsed.tool,
      proposalId: reParsed.proposalId,
      version: reParsed.version,
      riskClass: reParsed.riskClass,
    } as ProposedActionEnvelope;
    assert.equal(canonicalizeEnvelope(a), canonicalizeEnvelope(b));
    assert.equal(canonicalizeEnvelope(a), canonicalizeEnvelope(shuffled));
    assert.equal(digestEnvelope(a), digestEnvelope(b));
    assert.equal(digestEnvelope(a), digestEnvelope(shuffled));
  });

  it("strips undefined fields so missing vs explicit-undefined are identical", () => {
    const withUndefined = makeEnvelope({ workflow: undefined, actionKind: undefined });
    const plain = makeEnvelope();
    assert.equal(canonicalizeEnvelope(withUndefined), canonicalizeEnvelope(plain));
    assert.equal(digestEnvelope(withUndefined), digestEnvelope(plain));
  });

  it("throws on non-finite numbers (no NaN/Infinity leaks into the digest)", () => {
    assert.throws(() => canonicalizeEnvelope(makeEnvelope({ proposedAt: Number.NaN })));
    assert.throws(() => canonicalizeEnvelope(makeEnvelope({ proposedAt: Number.POSITIVE_INFINITY })));
  });

  it("element fingerprints rotate independently from envelope digests", () => {
    const fp1 = fingerprintElement("<button>OK</button>", { id: "submit", class: "btn" });
    const fp2 = fingerprintElement("<button>OK</button>", { id: "submit", class: "btn-primary" });
    const fp3 = fingerprintElement("<button>Cancel</button>", { id: "submit", class: "btn" });
    assert.notEqual(fp1, fp2, "different attribute -> different fingerprint");
    assert.notEqual(fp1, fp3, "different outerHTML -> different fingerprint");
    assert.equal(fp1.length, 64);
  });

  it("originFromUrl handles malformed inputs", () => {
    assert.equal(originFromUrl(""), "");
    assert.equal(originFromUrl("not a url"), "");
    assert.equal(originFromUrl("https://example.com"), "https://example.com");
    assert.equal(originFromUrl("https://example.com:8443/path"), "https://example.com:8443");
  });
});

describe("risk classifier (#81)", () => {
  it("returns the static tool class when no signals elevate it", () => {
    assert.equal(
      classifyRisk("browser_click", {
        effectiveUrl: "https://example.com",
        origin: "https://example.com",
        arguments: {},
      }),
      "mutate",
    );
    assert.equal(
      classifyRisk("browser_snapshot", {
        effectiveUrl: "https://example.com",
        origin: "https://example.com",
        arguments: {},
      }),
      "read",
    );
  });

  it("elevates loopback / private origins to sensitive", () => {
    assert.equal(
      classifyRisk("browser_click", {
        effectiveUrl: "http://localhost:3000",
        origin: "http://localhost:3000",
        arguments: {},
      }),
      "sensitive",
    );
    assert.equal(
      classifyRisk("browser_click", {
        effectiveUrl: "http://192.168.1.10/",
        origin: "http://192.168.1.10",
        arguments: {},
      }),
      "sensitive",
    );
  });

  it("elevates file:// / data: / javascript: to irreversible", () => {
    assert.equal(
      classifyRisk("browser_navigate", {
        effectiveUrl: "file:///etc/passwd",
        origin: "file://",
        arguments: {},
      }),
      "irreversible",
    );
    assert.equal(
      classifyRisk("browser_navigate", {
        effectiveUrl: "javascript:alert(1)",
        origin: "javascript:",
        arguments: {},
      }),
      "irreversible",
    );
  });

  it("elevates monetary hints in arguments to irreversible", () => {
    assert.equal(
      classifyRisk("browser_click", {
        effectiveUrl: "https://example.com",
        origin: "https://example.com",
        arguments: { amount: "99.99" },
      }),
      "irreversible",
    );
  });

  it("combines monotonic risk classes", () => {
    assert.equal(combineRisk("read", "mutate"), "mutate");
    assert.equal(combineRisk("sensitive", "irreversible"), "irreversible");
    assert.equal(combineRisk("irreversible", "read"), "irreversible");
  });

  it("POST form to non-loopback is sensitive even with read tool", () => {
    assert.equal(
      classifyRisk("browser_snapshot", {
        effectiveUrl: "https://example.com",
        origin: "https://example.com",
        formAction: "https://api.example.com/submit",
        formMethod: "POST",
        arguments: {},
      }),
      "sensitive",
    );
  });
});

describe("ActionGate propose (#81)", () => {
  it("returns permitted=true for mutate (no approval required)", () => {
    const { gate } = makeGate();
    const res = gate.propose({
      sessionId: "s-1",
      tool: "browser_click",
      arguments: { selector: "button" },
      live: live(),
    });
    assert.equal(res.permitted, true);
    assert.equal(res.requiresApproval, false);
    assert.equal(res.riskClass, "mutate");
    assert.equal(res.envelopeDigest.length, 64);
  });

  it("returns requiresApproval=true for sensitive tools and records digest", () => {
    const { gate } = makeGate();
    const res = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
    });
    assert.equal(res.requiresApproval, true);
    assert.equal(res.permitted, false);
    assert.equal(res.riskClass, "sensitive");
    assert.match(res.envelopeDigest, /^[a-f0-9]{64}$/);
  });

  it("records proposal.classified audit event with riskClass", () => {
    const { gate, audit } = makeGate();
    gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const classified = audit.events().find((e) => e.kind === "proposal.classified");
    assert.ok(classified);
    assert.equal(classified?.riskClass, "sensitive");
    assert.equal(classified?.tool, "browser_evaluate");
  });

  it("the same envelope re-canonicalized yields the same digest", () => {
    const { gate } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_click",
      arguments: { selector: "a" },
      live: live(),
    });
    const digestA = digestEnvelope(proposal.envelope);
    const digestB = digestEnvelope(proposal.envelope);
    assert.equal(digestA, proposal.envelopeDigest);
    assert.equal(digestB, proposal.envelopeDigest);
  });

  it("two independent proposals for the same args produce distinct digests (per-proposal binding)", () => {
    const { gate } = makeGate();
    const args = { sessionId: "s-1", tool: "browser_click", arguments: { selector: "a" }, live: live() };
    const a = gate.propose(args);
    const b = gate.propose(args);
    assert.notEqual(
      a.envelopeDigest,
      b.envelopeDigest,
      "each proposal is bound to its own proposalId + proposedAt",
    );
  });

  it("changes to URL invalidate the digest (TOCTOU pre-check at proposal time)", () => {
    const { gate } = makeGate();
    const a = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live({ pageUrl: "https://example.com/a" }),
    });
    const b = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live({ pageUrl: "https://example.com/b" }),
    });
    assert.notEqual(a.envelopeDigest, b.envelopeDigest);
  });
});

describe("ActionGate dispatch — TOCTOU binding (#81)", () => {
  it("permits a dispatch whose live digest matches the approval digest", () => {
    const { gate, approvals } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "human-1",
      decision: "approve",
      summary: summarizeEnvelope(proposal.envelope),
    });
    assert.equal(approvals.size(), 1);

    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, true);
    assert.equal(approvals.size(), 0, "approval is consumed");
  });

  it("rejects replay of the same approval id (one-time use)", () => {
    const { gate, audit } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    const first = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    const second = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { fn: "() => 1" },
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(first.permitted, true);
    assert.equal(second.permitted, false);
    assert.equal(second.reason, "already_consumed");
    assert.ok(audit.events().some((e) => e.kind === "approval.rejected" && e.reason === "already_consumed"));
  });

  it("rejects dispatch when the live URL changed since approval (TOCTOU)", () => {
    const { gate, audit } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live({
        pageUrl: "https://example.com/checkout",
        frameUrl: "https://example.com/checkout",
        effectiveUrl: "https://example.com/checkout",
      }),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live({
        pageUrl: "https://malicious.example/different",
        frameUrl: "https://malicious.example/different",
        effectiveUrl: "https://malicious.example/different",
      }),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "envelope_changed");
    assert.ok(audit.events().some((e) => e.kind === "approval.rejected" && e.reason === "envelope_changed"));
  });

  it("rejects silent risk downgrade between proposal and dispatch", () => {
    const { gate, approvals } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    // Adapter attempts to gate the same call with a lower risk class —
    // the store refuses because the recorded risk is higher.
    const result = approvals.consume({
      approvalId: rec.id,
      envelopeDigest: proposal.envelopeDigest,
      riskClass: "mutate",
      liveSecretVersions: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "risk_downgrade");
  });

  it("rejects dispatch when an approval is missing", () => {
    const { gate } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      // no approvalId at all
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "approval_missing");
  });

  it("rejects dispatch when an approval is for `deny`", () => {
    const { gate } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "deny",
      summary: "no",
    });
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "decision_is_deny");
  });

  it("rejects dispatch when the approval has expired", () => {
    let now = 1_000_000;
    const { gate } = makeGate({ ttl: 100 });
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      now: () => now,
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
      now: () => now,
    });
    now += 5_000;
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      approvalId: rec.id,
      now: () => now,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "expired");
  });

  it("rejects dispatch when an approval id is unknown", () => {
    const { gate } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      approvalId: "00000000-0000-0000-0000-000000000000",
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "unknown_approval");
  });

  it("rejects dispatch when secret version drifted between approval and dispatch", () => {
    const { gate, audit } = makeGate();
    const proposalLive = live({ liveSecretVersions: { "secret-1": 1 } });
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: proposalLive,
      secrets: [{ id: "secret-1", version: 1, versionHash: "aa".repeat(32) }],
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    // Live state at dispatch must keep the same URL/frame/origin as at
    // proposal time but report a higher secret version.
    const dispatchLive = live({ liveSecretVersions: { "secret-1": 2 } });
    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: dispatchLive,
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "secret_version_drift");
    assert.ok(
      audit.events().some((e) => e.kind === "approval.rejected" && e.reason === "secret_version_drift"),
    );
  });

  it("denies tools on the policy deny list even with an approval", () => {
    const { gate, approvals } = makeGate({
      policy: {
        requireApprovalFor: () => true,
        approvalTtlMs: 60_000,
        denyTools: new Set(["browser_evaluate"]),
        policyId: "test",
      },
    });
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    // No approval can be minted because the gate refuses proposals outright.
    assert.equal(proposal.permitted, false);
    assert.equal(proposal.reason, "tool_denied_by_policy");
    assert.equal(approvals.size(), 0);

    const dispatch = gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    assert.equal(dispatch.permitted, false);
    assert.equal(dispatch.reason, "tool_denied_by_policy");
  });
});

describe("ActionGate audit (#81 / #52)", () => {
  it("records proposal.classified, approval.minted, approval.consumed, dispatch.completed", () => {
    const { gate, audit } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "human",
      decision: "approve",
      summary: "ok",
    });
    gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    gate.recordDispatch(
      {
        sessionId: "s-1",
        tool: "browser_evaluate",
        envelopeDigest: proposal.envelopeDigest,
        proposalId: proposal.envelope.proposalId,
      },
      { ok: true },
    );

    const kinds = audit.events().map((e) => e.kind);
    assert.ok(kinds.includes("proposal.classified"), `missing proposal.classified; got ${kinds.join(",")}`);
    assert.ok(kinds.includes("approval.minted"), `missing approval.minted; got ${kinds.join(",")}`);
    assert.ok(kinds.includes("approval.consumed"), `missing approval.consumed; got ${kinds.join(",")}`);
    assert.ok(kinds.includes("dispatch.completed"), `missing dispatch.completed; got ${kinds.join(",")}`);
  });

  it("never embeds plaintext secrets in audit context (secrets are referenced, not stored)", () => {
    const { gate, audit } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { password: "super-secret-plaintext-1" },
      live: live(),
      secrets: [{ id: "cred-1", version: 1, versionHash: "ee".repeat(32) }],
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    gate.gate({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: { password: "super-secret-plaintext-1" },
      live: live(),
      approvalId: rec.id,
      proposal: proposal.envelope,
      proposalEnvelopeDigest: proposal.envelopeDigest,
    });
    for (const ev of audit.events()) {
      const blob = JSON.stringify(ev);
      assert.ok(!blob.includes("super-secret-plaintext-1"), `audit leaked plaintext: ${ev.kind}`);
    }
  });
});

describe("ApprovalStore (#81)", () => {
  it("two approvals for the same envelope carry distinct ids and nonces", () => {
    const { gate } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const a = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "u1",
      decision: "approve",
      summary: "ok",
    });
    // The first mint consumes the digest binding; a second mint for the
    // same digest would create a second non-blanket, single-use approval
    // — but it remains bound to that digest, so this is intentionally
    // not a "blanket" approval.
    const b = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "u2",
      decision: "approve",
      summary: "also ok",
    });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.nonce, b.nonce);
    // Both approvals share the envelopeDigest — they are bound to the
    // exact execution intent, not to a session / user.
    assert.equal(a.envelopeDigest, b.envelopeDigest);
    assert.equal(a.envelopeDigest, proposal.envelopeDigest);
  });

  it("findActiveByDigest returns the matching live approval", () => {
    const { gate, approvals } = makeGate();
    const proposal = gate.propose({
      sessionId: "s-1",
      tool: "browser_evaluate",
      arguments: {},
      live: live(),
    });
    const rec = gate.mintApproval({
      envelope: proposal.envelope,
      envelopeDigest: proposal.envelopeDigest,
      approverId: "h",
      decision: "approve",
      summary: "ok",
    });
    const found = approvals.findActiveByDigest(proposal.envelopeDigest);
    assert.equal(found?.id, rec.id);
  });
});

describe("summarizeEnvelope (#81)", () => {
  it("includes tool, risk, origin, target, and secret refs but never plaintext", () => {
    const env = makeEnvelope({
      arguments: { password: "super-secret-plaintext-2" },
      secrets: [{ id: "cred-x", version: 7, versionHash: "ff".repeat(32) }],
    });
    const s = summarizeEnvelope(env);
    assert.match(s, /browser_click/);
    assert.match(s, /sensitive/);
    assert.match(s, /https:\/\/example\.com/);
    assert.match(s, /cred-x@v7/);
    assert.ok(!s.includes("super-secret-plaintext-2"));
  });
});
