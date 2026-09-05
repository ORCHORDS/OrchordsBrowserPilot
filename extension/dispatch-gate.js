// Dispatch-side enforcement for per-site authorizations (#124).
//
// The registry in `site-authorizations.js` records grants and denials but does
// not, by itself, decide whether a specific dispatch against a specific tab is
// allowed. This module is the wire-side bridge: it takes an issued
// attachment token, looks up the tab at dispatch time, and combines
//
//   - the registry's `decisionFor` verdict for the active origin, and
//   - a TOCTOU cross-origin recheck between the origin captured at attach
//     time and the origin currently loaded in the tab,
//
// into a single authoritative `enforce(...)` verdict. If the verdict is
// positive and the grant kind is `ONCE`, the registry's once-token is consumed
// here so the audit trail records the exact run ID.
//
// This module stays pure of `chrome.*` imports — `tabsApi` is injected — so
// the gate can be exercised without a live browser.

const ATTACHMENT_VERSION = 1;

function originFromUrl(urlLike) {
  if (typeof urlLike !== "string" || urlLike.length === 0) return null;
  try {
    const u = new URL(urlLike);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   registry: ReturnType<import("./site-authorizations.js").createSiteAuthorizations>,
 *   attachment: ReturnType<import("./tab-attachment.js").createTabAttachment>,
 *   tabsApi?: { get: (tabId: number) => Promise<{ id: number; url?: string | null } | null> },
 * }} options
 */
export function createDispatchGate({ registry, attachment, tabsApi } = {}) {
  if (!registry) throw new Error("createDispatchGate requires registry");
  if (!attachment || typeof attachment.get !== "function") {
    throw new Error("createDispatchGate requires a tab-attachment-shaped adapter");
  }

  function recordAudit(entry) {
    if (typeof registry.recordAudit === "function") {
      try { registry.recordAudit(entry); } catch { /* never block dispatch on audit */ }
    }
  }

  /**
   * Returns one of:
   *   { allowed: true, decision: "session"|"once_consumed", origin, attachment }
   *   { allowed: false, code, origin, reason, attachment }
   * The caller (the service worker) decides how to surface a denial —
   * it cannot silently bypass the gate.
   *
   * @param {{ token: string, intent?: string, runId?: string }} req
   */
  async function enforce(req = {}) {
    const token = typeof req?.token === "string" ? req.token : "";
    if (!token) {
      return { allowed: false, code: "unknown_attachment_token", reason: "missing attachment token" };
    }
    const info = attachment.get(token);
    if (!info) {
      return { allowed: false, code: "unknown_attachment_token", reason: "attachment token not found" };
    }
    if (info.version !== ATTACHMENT_VERSION) {
      return {
        allowed: false,
        code: "stale_attachment",
        origin: null,
        reason: `attachment token version ${info.version} is not current`,
      };
    }
    // TOCTOU re-check: the live tab URL must be within the origin captured
    // at attach time. If the tab has navigated cross-origin (e.g. via a
    // redirect, a hyperlink, or a sandbox escape) the original grant no
    // longer applies and the dispatch must be refused.
    const attachedOrigin = originFromUrl(info.url);
    if (!attachedOrigin) {
      return {
        allowed: false,
        code: "attachment_not_origin_grounded",
        reason: "attachment URL was not a parseable http(s) URL",
      };
    }

    // Live URL recheck (only when a tabsApi was injected — tests without
    // Chrome hooks exercise the static path).
    let liveUrl = info.url;
    if (tabsApi && Number.isInteger(info.tabId)) {
      const liveTab = await tabsApi.get(info.tabId);
      if (!liveTab || typeof liveTab.url !== "string" || liveTab.url.length === 0) {
        return {
          allowed: false,
          code: "tab_url_unreadable",
          origin: null,
          reason: "could not read current tab URL",
        };
      }
      liveUrl = liveTab.url;
      const liveOrigin = originFromUrl(liveUrl);
      if (!liveOrigin) {
        return {
          allowed: false,
          code: "tab_origin_invalid",
          reason: "live tab URL was not a parseable http(s) URL",
        };
      }
      if (liveOrigin !== attachedOrigin) {
        recordAudit({
          kind: "dispatch.drifted_origin",
          origin: attachedOrigin,
          liveOrigin,
          token,
          runId: req.runId ?? null,
          intent: req.intent ?? "act",
        });
        return {
          allowed: false,
          code: "tab_drifted_origin",
          origin: attachedOrigin,
          liveOrigin,
          reason: `tab navigated cross-origin from ${attachedOrigin} to ${liveOrigin}`,
        };
      }
    }

    const decision = registry.decisionFor(`https://${attachedOrigin}`, req.intent ?? "act");
    if (decision.kind === "denied") {
      recordAudit({
        kind: "dispatch.denied",
        origin: decision.origin,
        reason: decision.reason,
        token,
        runId: req.runId ?? null,
        intent: req.intent ?? "act",
      });
      return {
        allowed: false,
        code: "site_authorization_denied",
        origin: decision.origin,
        reason: decision.reason,
        attachment: info,
      };
    }
    if (decision.kind === "unknown") {
      recordAudit({
        kind: "dispatch.unknown_origin",
        origin: decision.origin,
        reason: decision.reason,
        token,
        runId: req.runId ?? null,
        intent: req.intent ?? "act",
      });
      return {
        allowed: false,
        code: "site_authorization_unknown",
        origin: decision.origin,
        reason: decision.reason,
        attachment: info,
      };
    }

    // Allowed path. For `ONCE`, consume atomically.
    if (decision.grantKind === "once") {
      const consumed = registry.consumeOnce(`https://${attachedOrigin}`);
      if (!consumed) {
        recordAudit({
          kind: "dispatch.once_race_lost",
          origin: attachedOrigin,
          token,
          runId: req.runId ?? null,
        });
        return {
          allowed: false,
          code: "site_authorization_once_race",
          origin: attachedOrigin,
          reason: "another dispatch consumed the once grant first",
          attachment: info,
        };
      }
      recordAudit({
        kind: "dispatch.consumed_once",
        origin: attachedOrigin,
        token,
        runId: req.runId ?? null,
        intent: req.intent ?? "act",
        liveUrl,
      });
      return { allowed: true, decision: "once_consumed", origin: attachedOrigin, attachment: info };
    }

    recordAudit({
      kind: "dispatch.allowed",
      origin: attachedOrigin,
      grantKind: decision.grantKind,
      token,
      runId: req.runId ?? null,
      intent: req.intent ?? "act",
      liveUrl,
    });
    return { allowed: true, decision: "session", origin: attachedOrigin, attachment: info };
  }

  return { enforce, _originFromUrl: originFromUrl };
}

export const DISPATCH_GATE_VERSION = ATTACHMENT_VERSION;
