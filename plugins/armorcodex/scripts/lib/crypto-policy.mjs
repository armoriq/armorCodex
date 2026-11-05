import { isPlainObject, postJson, sha256Hex } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { requireEndpoint } from "./config.mjs";
import path from "node:path";

export function computePolicyDigest(rules) {
  if (!Array.isArray(rules)) return sha256Hex("policy|[]");
  const canonical = JSON.stringify(
    rules.map((r) => ({
      id: r.id,
      action: r.action,
      tool: r.tool,
      dataClass: r.dataClass,
      params: r.params,
      scope: r.scope
    })),
    null,
    0
  );
  return sha256Hex(`policy|${canonical}`);
}

export function createCryptoPolicyService(config) {
  const timeoutMs = config.timeoutMs || 30000;
  const stateFilePath = path.join(config.dataDir, "crypto-policy-state.json");

  return {
    async issuePolicyToken(policyState, identity, validitySeconds = 3600) {
      const digest = computePolicyDigest(policyState.policy?.rules || []);

      const policyMetadata = {
        rules: policyState.policy?.rules || [],
        version: policyState.version || 0,
        updated_at: policyState.updatedAt || new Date().toISOString(),
        updated_by: policyState.updatedBy,
        policy_digest: digest
      };

      const plan = buildPolicyPlan(policyState.policy);

      const request = {
        plan,
        policy: {
          global: {
            metadata: policyMetadata
          }
        },
        identity: {
          user_id: identity.userId || config.userId || "codex-user",
          agent_id: identity.agentId || config.agentId || "codex",
          context_id: identity.contextId || config.contextId || "default"
        },
        validity_seconds: validitySeconds
      };

      const response = await postJson(
        `${requireEndpoint(config, "csrgEndpoint")}/intent`,
        request,
        { "Content-Type": "application/json" },
        timeoutMs
      );

      if (!response.ok || !response.data) {
        const msg = response.text || `CSRG /intent failed with status ${response.status}`;
        throw new Error(`Policy token issuance failed: ${msg}`);
      }

      const token = {
        ...response.data,
        policy_digest: digest
      };

      await writeJson(stateFilePath, {
        token,
        policyDigest: digest,
        issuedAt: Date.now()
      });

      return token;
    },

    verifyPolicyDigest(currentDigest, tokenDigest) {
      if (!tokenDigest) {
        return {
          valid: false,
          reason: "No policy token - policy not cryptographically bound"
        };
      }
      if (currentDigest !== tokenDigest) {
        return {
          valid: false,
          reason: `Policy mismatch: current=${currentDigest.slice(0, 16)}... token=${tokenDigest.slice(0, 16)}...`
        };
      }
      return { valid: true, reason: "Policy digest verified" };
    },

    async verifyPolicyRule(ruleId, toolName) {
      const cached = await this.loadCachedState();
      if (!cached?.token) {
        return { allowed: false, reason: "No policy token cached" };
      }

      const ruleProof = cached.token.step_proofs?.find(
        (p) => p.path?.includes(ruleId) || p.path?.includes(toolName)
      );

      if (!ruleProof) {
        return { allowed: true, reason: "No specific proof required" };
      }

      const verifyRequest = {
        path: ruleProof.path,
        value: { tool: toolName, rule_id: ruleId },
        proof: ruleProof.proof,
        token: cached.token.token
      };

      const response = await postJson(
        `${requireEndpoint(config, "csrgEndpoint")}/verify/action`,
        verifyRequest,
        { "Content-Type": "application/json" },
        Math.min(timeoutMs, 15000)
      );

      if (!response.ok || !response.data) {
        return {
          allowed: false,
          reason: response.text || "CSRG verification failed"
        };
      }

      return response.data;
    },

    async loadCachedState() {
      return await readJson(stateFilePath, null);
    },

    async clearCache() {
      try {
        await writeJson(stateFilePath, null);
      } catch { /* ignore */ }
    }
  };
}

function buildPolicyPlan(policy) {
  const rules = Array.isArray(policy?.rules) ? policy.rules : [];

  const steps = rules.map((rule) => ({
    action: `policy_rule:${rule.id}`,
    mcp: "armoriq-policy",
    description: `Rule: ${rule.action} ${rule.tool}${rule.dataClass ? ` for ${rule.dataClass}` : ""}`,
    metadata: {
      rule_id: rule.id,
      rule_action: rule.action,
      rule_tool: rule.tool,
      rule_data_class: rule.dataClass,
      rule_params: rule.params,
      rule_scope: rule.scope
    }
  }));

  if (steps.length === 0) {
    steps.push({
      action: "policy_rule:allow-all",
      mcp: "armoriq-policy",
      description: "Default: allow all",
      metadata: {
        rule_id: "allow-all",
        rule_action: "allow",
        rule_tool: "*",
        rule_data_class: undefined,
        rule_params: undefined,
        rule_scope: undefined
      }
    });
  }

  return {
    steps,
    metadata: {
      goal: "ArmorIQ policy enforcement",
      policy_type: "crypto-bound"
    }
  };
}
