import { readFile } from "node:fs/promises";
import type { ProviderAccountStatus } from "./store.js";

/**
 * pi-account-switcher awareness (R8.5): read-only status reporting. Ported
 * from the legacy profile-switcher's `storage/account-switcher.ts`.
 */

export interface AccountSwitcherAccountInfo {
  id: string;
  label: string;
  provider: string;
}

export async function loadAccountSwitcherAccounts(accountsPath: string): Promise<AccountSwitcherAccountInfo[]> {
  try {
    const rawContent = await readFile(accountsPath, "utf8");
    const parsed = JSON.parse(rawContent) as { accounts?: AccountSwitcherAccountInfo[] };
    if (Array.isArray(parsed?.accounts)) {
      return parsed.accounts;
    }
    return [];
  } catch {
    return [];
  }
}

export async function loadAccountSwitcherSelected(statePath: string): Promise<Record<string, string>> {
  try {
    const rawContent = await readFile(statePath, "utf8");
    const parsed = JSON.parse(rawContent) as { selected?: Record<string, string> };
    if (parsed?.selected && typeof parsed.selected === "object") {
      return parsed.selected;
    }
    return {};
  } catch {
    return {};
  }
}

export async function getProviderAccountStatuses(
  providers: string[],
  accountsPath: string,
  statePath: string,
): Promise<Record<string, ProviderAccountStatus>> {
  const accounts = await loadAccountSwitcherAccounts(accountsPath);
  const selected = await loadAccountSwitcherSelected(statePath);

  const statuses: Record<string, ProviderAccountStatus> = {};

  for (const provider of providers) {
    const matchingAccounts = accounts.filter((account) => account.provider.toLowerCase() === provider.toLowerCase());
    const activeAccountId = selected[provider.toLowerCase()];
    const activeAccount = matchingAccounts.find((account) => account.id === activeAccountId);

    statuses[provider] = {
      configuredAccounts: matchingAccounts,
      activeAccountId,
      activeAccountLabel: activeAccount?.label,
    };
  }

  return statuses;
}
