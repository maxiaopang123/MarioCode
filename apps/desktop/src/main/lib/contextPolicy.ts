import { CONTEXT_POLICY_SETTING_KEY, parseContextPolicy } from "@contracts/contextPolicy";
import { SettingRepo } from "@main/store/repositories.js";

/** Read every turn so changing the policy also applies to resumed sessions. */
export function readContextPolicy() {
  return parseContextPolicy(SettingRepo.get(CONTEXT_POLICY_SETTING_KEY));
}
