import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { JevProfile, Mode, ProfilesCollection, Tier } from "../domain/types.js";
import { TIERS } from "../domain/types.js";
import { formatError, type ProviderAccountStatus } from "../profiles/store.js";
import {
  cloneProfile,
  deleteProfile,
  ensureExampleProfiles,
  extractProvidersFromProfile,
  formatProfileDetailView,
  formatProfileListItem,
  loadProfiles,
  renameProfile,
  saveProfiles,
} from "../profiles/store.js";
import { getProviderAccountStatuses } from "../profiles/accounts.js";
import { accountSwitcherAccountsPath, accountSwitcherStatePath } from "../storage/paths.js";
import { notify, setStatusText, statusLine } from "../ui/status.js";
import { formatUsd } from "../routing/budget.js";
import type { ProCommandsContext } from "./context.js";

/**
 * `/jev …` command surface (design §5): profile CRUD + switching ported from
 * the legacy switcher, re-issued under `/jev` with the legacy `/jev-profile*`
 * aliases kept working (R8.3). Switching is memory-only (R8.2).
 */

const USAGE_PROFILE =
  "usage: /jev profile list|switch <name>|current|show [name]|add [name]|save [name]|edit [name]|clone <src> <target>|remove [name]|reload|init|help";

async function accountStatusesFor(providers: string[]): Promise<Record<string, ProviderAccountStatus>> {
  return getProviderAccountStatuses(providers, accountSwitcherAccountsPath(), accountSwitcherStatePath());
}

/** Account-switcher advisory after a switch (read-only reporting, R8.5). */
async function reportAccountAdvisory(ctx: ExtensionCommandContext, providers: string[]): Promise<void> {
  if (providers.length === 0) return;
  const statuses = await accountStatusesFor(providers);
  const warnings: string[] = [];
  for (const [provider, status] of Object.entries(statuses)) {
    if (status.configuredAccounts.length > 0 && !status.activeAccountId) {
      warnings.push(`Provider "${provider}" has accounts configured in pi-account-switcher but none is currently selected. Use /account ${provider} to choose one.`);
    }
  }
  if (warnings.length > 0) notify(ctx, warnings.join("\n"), "warning");
}

async function loadCollection(profilesPath: string, ui: ExtensionCommandContext["ui"]): Promise<ProfilesCollection> {
  try {
    return await loadProfiles(profilesPath);
  } catch (error) {
    ui.notify(`Failed to load profiles: ${formatError(error)}`, "error");
    return {};
  }
}

// ---------------------------------------------------------------- switching

export async function handleProfileSwitch(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  const runtime = ctx.runtime;
  await runtime.reloadProfiles().catch(() => undefined);

  const requestedName = argumentText.trim();
  let targetProfileName: string | undefined = requestedName || undefined;

  if (!targetProfileName) {
    const selected = await promptSelectProfile(command.ui, "Select Jev Router Profile to Activate", runtime.getProfileNames(), (name) => runtime.getProfile(name), runtime.getActiveProfileName());
    if (!selected) return;
    targetProfileName = selected;
  }

  try {
    const result = await runtime.switchProfile(targetProfileName);
    setStatusText(
      command,
      statusLine(result.currentProfileName, ctx.lastDecision(), ctx.spend(), ctx.isDormant()),
    );
    notify(command, `Switched Jev router profile to "${result.currentProfileName}". Takes effect on the next request (no reload).`, "info");
    await reportAccountAdvisory(command, result.providers);
  } catch (error) {
    notify(command, `Failed to switch profile: ${formatError(error)}`, "error");
  }
}

async function promptSelectProfile(
  ui: ExtensionCommandContext["ui"],
  title: string,
  names: string[],
  getProfile: (name: string) => JevProfile | undefined,
  activeName: string | undefined,
): Promise<string | undefined> {
  if (names.length === 0) {
    ui.notify("No profiles found. Use /jev profile init or /jev profile add.", "warning");
    return undefined;
  }
  const options = names.map((name) => {
    const profile = getProfile(name);
    return profile ? formatProfileListItem(name, profile, name === activeName) : name;
  });
  const selectedOption = await ui.select(title, options);
  if (!selectedOption) return undefined;
  const index = options.indexOf(selectedOption);
  return index === -1 ? undefined : names[index];
}

// --------------------------------------------------------------------- list

export async function handleProfileList(_argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);
  const names = ctx.runtime.getProfileNames();
  if (names.length === 0) {
    notify(command, "No profiles found. Use /jev profile init to create starter profiles or /jev profile add to add one.", "warning");
    return;
  }
  const activeName = ctx.runtime.getActiveProfileName();
  const options = names.map((name) => {
    const profile = ctx.runtime.getProfile(name);
    return profile ? formatProfileListItem(name, profile, name === activeName) : name;
  });
  const selected = await command.ui.select("Jev Router Profiles (Select to switch or Esc to close)", options);
  if (!selected) return;
  const index = options.indexOf(selected);
  if (index !== -1) {
    await handleProfileSwitch(names[index], ctx);
  }
}

// ------------------------------------------------------------------- switch helpers end

export async function handleProfileCurrent(_argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);
  const activeProfileName = ctx.runtime.getActiveProfileName();
  if (!activeProfileName) {
    notify(command, "No Jev router profile is currently active. Use /jev profile switch <name> to select one.", "warning");
    return;
  }
  const profile = ctx.runtime.getProfile(activeProfileName);
  if (!profile) {
    notify(command, `Active profile "${activeProfileName}" was not found in profiles collection.`, "error");
    return;
  }
  const providers = extractProvidersFromProfile(profile);
  const accountStatuses = await accountStatusesFor(providers);
  notify(command, formatProfileDetailView(activeProfileName, profile, true, accountStatuses), "info");
}

export async function handleProfileShow(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);
  let targetProfileName = argumentText.trim();
  if (!targetProfileName) {
    targetProfileName =
      (await promptSelectProfile(command.ui, "Select Jev Router Profile to Show", ctx.runtime.getProfileNames(), (name) => ctx.runtime.getProfile(name), ctx.runtime.getActiveProfileName())) ?? "";
    if (!targetProfileName) return;
  }
  const profile = ctx.runtime.getProfile(targetProfileName);
  if (!profile) {
    notify(command, `Profile "${targetProfileName}" does not exist.`, "error");
    return;
  }
  const isActive = ctx.runtime.getActiveProfileName() === targetProfileName;
  const providers = extractProvidersFromProfile(profile);
  const accountStatuses = await accountStatusesFor(providers);
  notify(command, formatProfileDetailView(targetProfileName, profile, isActive, accountStatuses), "info");
}

// ---------------------------------------------------------------------- add

export async function handleProfileAdd(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);

  let targetProfileName = argumentText.trim();
  if (!targetProfileName) {
    const inputName = await command.ui.input("Enter a name for the new profile:", "e.g. google-fast, custom-openrouter, anthropic-deepseek");
    if (!inputName || !inputName.trim()) return;
    targetProfileName = inputName.trim();
  }

  if (ctx.runtime.getProfile(targetProfileName)) {
    notify(command, `Profile "${targetProfileName}" already exists. Use a different name or edit the existing profile.`, "error");
    return;
  }

  const creationOptions = [
    "Capture the active profile's routing configuration",
    "Copy from an existing profile",
    "Open JSON editor to define profile from scratch",
  ];
  const selectedOption = await command.ui.select(`Create profile "${targetProfileName}" from:`, creationOptions);
  if (!selectedOption) return;

  let newProfile: JevProfile | undefined;

  if (selectedOption === creationOptions[0]) {
    const source = ctx.runtime.getSnapshotForSave();
    if (!source) {
      notify(command, "No active profile to capture. Switch to a profile first, or create one from the JSON editor.", "error");
      return;
    }
    const description = await command.ui.input("Optional description for this profile:", "e.g. Current live routing snapshot");
    newProfile = {
      ...structuredClone(source),
      ...(description?.trim() ? { description: description.trim() } : {}),
    };
  } else if (selectedOption === creationOptions[1]) {
    const sourceProfileName = await promptSelectProfile(command.ui, "Select profile to copy from:", ctx.runtime.getProfileNames(), (name) => ctx.runtime.getProfile(name), ctx.runtime.getActiveProfileName());
    if (!sourceProfileName) return;
    const sourceProfile = ctx.runtime.getProfile(sourceProfileName);
    if (!sourceProfile) {
      notify(command, `Source profile "${sourceProfileName}" not found.`, "error");
      return;
    }
    const description = await command.ui.input("Optional description for this profile:", sourceProfile.description ?? `Cloned from ${sourceProfileName}`);
    newProfile = {
      ...structuredClone(sourceProfile),
      description: description?.trim() || sourceProfile.description,
    };
  } else {
    const templateProfile: JevProfile = {
      description: "Custom router profile",
      useDefaultModels: false,
      routes: {
        quick: [{ provider: "google", model: "gemini-3.5-flash-lite" }],
        standard: [{ provider: "google", model: "gemini-3.8-flash" }],
        high: [{ provider: "google", model: "gemini-3.8-flash" }],
        premium: [{ provider: "google", model: "gemini-3.8-flash" }],
      },
      kindModels: {},
    };
    const initialJson = JSON.stringify(templateProfile, null, 2);
    const editedJson = await command.ui.editor(`Edit New Profile: ${targetProfileName}`, initialJson);
    if (!editedJson) {
      notify(command, "Profile creation cancelled.", "info");
      return;
    }
    try {
      newProfile = JSON.parse(editedJson) as JevProfile;
    } catch (parseError) {
      notify(command, `Invalid JSON syntax: ${formatError(parseError)}. Profile was not created.`, "error");
      return;
    }
  }

  if (!newProfile) return;

  try {
    const profiles = await loadCollection(ctx.runtime.profilesPath, command.ui);
    profiles[targetProfileName] = newProfile;
    await saveProfiles(profiles, ctx.runtime.profilesPath);
    await ctx.runtime.reloadProfiles();
    notify(command, `Successfully created profile "${targetProfileName}".`, "info");

    const shouldSwitchNow = await command.ui.confirm("Activate Profile", `Do you want to switch to "${targetProfileName}" right now?`);
    if (shouldSwitchNow) {
      await handleProfileSwitch(targetProfileName, ctx);
    }
  } catch (error) {
    notify(command, `Failed to create profile: ${formatError(error)}`, "error");
  }
}

// --------------------------------------------------------------------- save

/**
 * Persist a profile into the profiles file. The special name `default-import`
 * persists the implicit legacy-imported `default` profile (R9.1 first-run
 * offer); otherwise the active profile's routing config is captured.
 */
export async function handleProfileSave(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);

  let targetProfileName = argumentText.trim();
  const implicitDefault = ctx.runtime.getProfile("default");
  if (!targetProfileName && implicitDefault && ctx.runtime.getActiveProfileName() === "default") {
    targetProfileName = "default-import";
  }
  if (!targetProfileName) {
    const inputName = await command.ui.input("Save the active profile's routing config as profile name:", ctx.runtime.getActiveProfileName() ?? "my-profile");
    if (!inputName || !inputName.trim()) return;
    targetProfileName = inputName.trim();
  }

  const snapshotSource =
    targetProfileName === "default-import" ? implicitDefault : ctx.runtime.getSnapshotForSave();
  if (!snapshotSource) {
    notify(command, "No active profile to save. Use /jev profile add to define one from scratch.", "warning");
    return;
  }
  const saveName = targetProfileName === "default-import" ? "default" : targetProfileName;

  const profiles = await loadCollection(ctx.runtime.profilesPath, command.ui);
  if (profiles[saveName]) {
    const shouldOverwrite = await command.ui.confirm(
      "Overwrite Existing Profile",
      `Profile "${saveName}" already exists. Do you want to overwrite it with the current routing configuration?`,
    );
    if (!shouldOverwrite) {
      notify(command, "Save profile cancelled.", "info");
      return;
    }
  }

  try {
    profiles[saveName] = { ...structuredClone(snapshotSource) };
    await saveProfiles(profiles, ctx.runtime.profilesPath);
    await ctx.runtime.reloadProfiles();
    await ctx.runtime.switchProfile(saveName);
    notify(command, `Successfully saved routing configuration as profile "${saveName}".`, "info");
  } catch (error) {
    notify(command, `Failed to save profile: ${formatError(error)}`, "error");
  }
}

// --------------------------------------------------------------------- edit

export async function handleProfileEdit(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);

  let targetProfileName = argumentText.trim();
  if (!targetProfileName) {
    targetProfileName =
      (await promptSelectProfile(command.ui, "Select Jev Router Profile to Edit", ctx.runtime.getProfileNames(), (name) => ctx.runtime.getProfile(name), ctx.runtime.getActiveProfileName())) ?? "";
    if (!targetProfileName) return;
  }
  const existingProfile = ctx.runtime.getProfile(targetProfileName);
  if (!existingProfile) {
    notify(command, `Profile "${targetProfileName}" does not exist.`, "error");
    return;
  }

  const editActions = [
    "Open full JSON in editor",
    "Rename profile",
    "Update description",
    `Toggle useDefaultModels (currently: ${existingProfile.useDefaultModels === false ? "false" : "true"})`,
    "Overwrite with the active profile's routing configuration",
  ];
  const chosenAction = await command.ui.select(`Edit Profile "${targetProfileName}":`, editActions);
  if (!chosenAction) return;

  try {
    const profiles = await loadCollection(ctx.runtime.profilesPath, command.ui);
    if (chosenAction === editActions[0]) {
      const currentJson = JSON.stringify(existingProfile, null, 2);
      const editedJson = await command.ui.editor(`Edit Profile: ${targetProfileName}`, currentJson);
      if (!editedJson) {
        notify(command, "Edit cancelled.", "info");
        return;
      }
      const updatedProfile = JSON.parse(editedJson) as JevProfile;
      profiles[targetProfileName] = updatedProfile;
      await saveProfiles(profiles, ctx.runtime.profilesPath);
      await ctx.runtime.reloadProfiles();
      notify(command, `Updated profile "${targetProfileName}".`, "info");
    } else if (chosenAction === editActions[1]) {
      const newNameInput = await command.ui.input("Enter new name for profile:", targetProfileName);
      const newName = newNameInput?.trim();
      if (!newName || newName === targetProfileName) return;
      await renameProfile(targetProfileName, newName, ctx.runtime.profilesPath);
      if (ctx.runtime.getActiveProfileName() === targetProfileName) {
        await ctx.runtime.switchProfile(newName);
      } else {
        await ctx.runtime.reloadProfiles();
      }
      notify(command, `Renamed profile "${targetProfileName}" to "${newName}".`, "info");
    } else if (chosenAction === editActions[2]) {
      const description = await command.ui.input("Enter the new description:", existingProfile.description ?? "");
      profiles[targetProfileName] = { ...existingProfile, description: description?.trim() || undefined };
      await saveProfiles(profiles, ctx.runtime.profilesPath);
      await ctx.runtime.reloadProfiles();
      notify(command, `Updated description of "${targetProfileName}".`, "info");
    } else if (chosenAction === editActions[3]) {
      const next = existingProfile.useDefaultModels === false;
      profiles[targetProfileName] = { ...existingProfile, useDefaultModels: next };
      await saveProfiles(profiles, ctx.runtime.profilesPath);
      await ctx.runtime.reloadProfiles();
      notify(command, `useDefaultModels for "${targetProfileName}" set to ${next}.`, "info");
    } else {
      const snapshot = ctx.runtime.getSnapshotForSave();
      if (!snapshot) {
        notify(command, "No active profile to copy from.", "error");
        return;
      }
      profiles[targetProfileName] = { ...structuredClone(snapshot), description: existingProfile.description };
      await saveProfiles(profiles, ctx.runtime.profilesPath);
      await ctx.runtime.reloadProfiles();
      notify(command, `Overwrote "${targetProfileName}" with the active routing configuration.`, "info");
    }
    if (ctx.runtime.getActiveProfileName() === targetProfileName) {
      await ctx.runtime.switchProfile(targetProfileName);
    }
  } catch (error) {
    notify(command, `Failed to edit profile: ${formatError(error)}`, "error");
  }
}

// ------------------------------------------------------- clone / remove

export async function handleProfileClone(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);

  const parts = argumentText.trim().split(/\s+/).filter(Boolean);
  let sourceProfileName = parts[0];
  let targetProfileName = parts[1];

  if (!sourceProfileName) {
    sourceProfileName =
      (await promptSelectProfile(command.ui, "Select Jev Router Profile to Clone", ctx.runtime.getProfileNames(), (name) => ctx.runtime.getProfile(name), ctx.runtime.getActiveProfileName())) ?? "";
    if (!sourceProfileName) return;
  }
  if (!targetProfileName) {
    const inputName = await command.ui.input(`Enter new name for cloned profile (copying from "${sourceProfileName}"):`, `${sourceProfileName}-copy`);
    if (!inputName || !inputName.trim()) return;
    targetProfileName = inputName.trim();
  }

  try {
    await cloneProfile(sourceProfileName, targetProfileName, ctx.runtime.profilesPath);
    await ctx.runtime.reloadProfiles();
    notify(command, `Successfully cloned profile "${sourceProfileName}" to "${targetProfileName}".`, "info");
  } catch (error) {
    notify(command, `Failed to clone profile: ${formatError(error)}`, "error");
  }
}

export async function handleProfileRemove(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const command = ctx.command;
  await ctx.runtime.reloadProfiles().catch(() => undefined);

  let targetProfileName = argumentText.trim();
  if (!targetProfileName) {
    targetProfileName =
      (await promptSelectProfile(command.ui, "Select Jev Router Profile to Remove", ctx.runtime.getProfileNames(), (name) => ctx.runtime.getProfile(name), ctx.runtime.getActiveProfileName())) ?? "";
    if (!targetProfileName) return;
  }
  if (!ctx.runtime.getProfile(targetProfileName)) {
    notify(command, `Profile "${targetProfileName}" does not exist.`, "error");
    return;
  }

  const isActive = ctx.runtime.getActiveProfileName() === targetProfileName;
  const activeWarning = isActive ? " (Note: This is the currently active profile! Active state will be cleared.)" : "";
  const shouldDelete = await command.ui.confirm("Delete Profile", `Are you sure you want to permanently delete profile "${targetProfileName}"?${activeWarning}`);
  if (!shouldDelete) {
    notify(command, "Deletion cancelled.", "info");
    return;
  }

  try {
    await deleteProfile(targetProfileName, ctx.runtime.profilesPath);
    if (isActive) {
      await ctx.runtime.clearActiveProfile();
    } else {
      await ctx.runtime.reloadProfiles();
    }
    notify(command, `Successfully deleted profile "${targetProfileName}".`, "info");
  } catch (error) {
    notify(command, `Failed to delete profile: ${formatError(error)}`, "error");
  }
}

// ------------------------------------------------------------ system ops

export async function handleProfileReload(_argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  try {
    await ctx.runtime.reloadProfiles();
    notify(ctx.command, "Reloaded Jev router profiles from disk.", "info");
  } catch (error) {
    notify(ctx.command, `Failed to reload profiles: ${formatError(error)}`, "error");
  }
}

export async function handleProfileInit(_argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<boolean> {
  try {
    const created = await ensureExampleProfiles(ctx.runtime.profilesPath);
    if (created) {
      await ctx.runtime.reloadProfiles();
      notify(ctx.command, `Created starter profiles at ${ctx.runtime.profilesPath}.`, "info");
    } else {
      notify(ctx.command, "Profiles file already exists.", "info");
    }
    return created;
  } catch (error) {
    notify(ctx.command, `Failed to initialize profiles: ${formatError(error)}`, "error");
    return false;
  }
}

export function handleProfileHelp(ctx: ProCommandsContext & { command: ExtensionCommandContext }): void {
  const helpText = [
    "pi-jev-router-pro commands:",
    "  /jev auto                   - Re-activate routing (select the virtual model)",
    "  /jev profile [name]         - Switch active profile (interactive picker if omitted)",
    "  /jev profile list           - List all profiles and switch interactively",
    "  /jev profile current        - View the active profile details and routes",
    "  /jev profile show [name]    - Inspect a profile's full configuration",
    "  /jev profile add [name]     - Add a new profile interactively or from JSON editor",
    "  /jev profile save [name]    - Capture the active routing config into a named profile",
    "  /jev profile edit [name]    - Edit, rename, or overwrite an existing profile",
    "  /jev profile clone <s> <t>  - Duplicate an existing profile",
    "  /jev profile remove [name]  - Permanently delete a profile",
    "  /jev profile init           - Create example profiles if missing",
    "  /jev profile reload         - Reload profiles from disk",
    "  /jev-router                 - Router status (mode, chains, parking, budget/quota)",
    "  /jev-route <text>           - Classify preview (no switching)",
    "",
    "Legacy aliases kept working:",
    "  /jev-profile [name], /jev-profiles, /jev-profile-current, /jev-profile-show,",
    "  /jev-profile-add, /jev-profile-save, /jev-profile-edit, /jev-profile-clone,",
    "  /jev-profile-remove, /jev-profile-reload, /jev-profile-init",
  ].join("\n");
  notify(ctx.command, helpText, "info");
}

/** `/jev` dispatcher: `profile …` subcommands, `auto`, and bare-name switch. */
export async function handleJevCommand(argumentText: string, ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const trimmed = argumentText.trim();
  if (!trimmed) {
    await handleProfileCurrent("", ctx);
    return;
  }
  const [first, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const restArgument = rest.join(" ");
  switch (first.toLowerCase()) {
    case "auto":
      await activateAndReport(ctx);
      return;
    case "profile":
    case "profiles": {
      const [sub] = rest;
      switch ((sub ?? "list").toLowerCase()) {
        case "switch":
          await handleProfileSwitch(restArgument.split(/\s+/).slice(1).join(" ") || restArgument, ctx);
          return;
        case "list":
          await handleProfileList(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "current":
          await handleProfileCurrent("", ctx);
          return;
        case "show":
          await handleProfileShow(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "add":
          await handleProfileAdd(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "save":
          await handleProfileSave(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "edit":
          await handleProfileEdit(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "clone": {
          const [source, target] = restArgument.split(/\s+/).filter(Boolean);
          await handleProfileClone([source, target].filter(Boolean).join(" "), ctx);
          return;
        }
        case "remove":
          await handleProfileRemove(restArgument.split(/\s+/).slice(1).join(" "), ctx);
          return;
        case "reload":
          await handleProfileReload("", ctx);
          return;
        case "init":
          await handleProfileInit("", ctx);
          return;
        case "help":
          handleProfileHelp(ctx);
          return;
        default: {
          // `/jev profile <name>` switches directly when it names a profile.
          if (ctx.runtime.getProfile(sub ?? "")) {
            await handleProfileSwitch(restArgument, ctx);
          } else {
            await handleProfileSwitch(trimmed.replace(/^profiles?\s+/i, ""), ctx);
          }
          return;
        }
      }
    }
    case "status":
      await handleProfileCurrent("", ctx);
      return;
    default:
      // Bare profile name switches directly.
      if (ctx.runtime.getProfile(first)) {
        await handleProfileSwitch(trimmed, ctx);
        return;
      }
      notify(ctx.command, `Unknown /jev subcommand "${first}". ${USAGE_PROFILE}`, "warning");
      return;
  }
}

async function activateAndReport(ctx: ProCommandsContext & { command: ExtensionCommandContext }): Promise<void> {
  const ok = await ctx.activateVirtual(ctx.command);
  if (ok) {
    notify(ctx.command, `Routing re-activated: ${ctx.virtualModelKey()} selected.`, "info");
  } else {
    notify(ctx.command, `Could not select ${ctx.virtualModelKey()} (not registered or provider unavailable).`, "error");
  }
}

// --------------------------------------------------------- /jev-router panel

/** `/jev-router [on|off|mode <m>|parking clear|quota]` (design §5). */
export function registerJevRouterCommand(pi: ExtensionAPI, ctx: ProCommandsContext): void {
  pi.registerCommand("jev-router", {
    description: "Jev router pro: status panel, on/off, consent mode, parking, quota",
    handler: async (args, command) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch ((sub ?? "status").toLowerCase()) {
        case "on":
          ctx.setEnabled(true);
          notify(command, "jev-router-pro enabled", "info");
          return;
        case "off":
          ctx.setEnabled(false);
          notify(command, "jev-router-pro disabled (inert until re-enabled)", "info");
          return;
        case "mode": {
          const mode = (rest[0] ?? "").toLowerCase();
          if (mode !== "auto" && mode !== "confirm" && mode !== "notify") {
            notify(command, "usage: /jev-router mode auto|confirm|notify", "warning");
            return;
          }
          ctx.setMode(mode as Mode);
          notify(command, `jev-router-pro mode: ${mode}`, "info");
          return;
        }
        case "parking": {
          if ((rest[0] ?? "").toLowerCase() === "clear") {
            const cleared = ctx.runtime.parking.clear();
            await ctx.runtime.persistState();
            notify(command, cleared ? "jev-router-pro: parking cleared" : "jev-router-pro: parks cleared in memory; state file could not be saved", cleared ? "info" : "warning");
          } else {
            notify(command, [`parking (persisted, TTL recovery.parkMs):`, ...(ctx.runtime.parking.list().length ? ctx.runtime.parking.list() : ["  (none)"])].join("\n"), "info");
          }
          return;
        }
        case "quota": {
          const { detail } = ctx.quotaLines();
          notify(command, detail.join("\n"), "info");
          return;
        }
        case "status":
        default: {
          notify(command, buildStatusPanel(ctx), "info");
          return;
        }
      }
    },
  });
}

function buildStatusPanel(ctx: ProCommandsContext): string {
  const { runtime } = ctx;
  const config = runtime.config;
  const models = ctx.getModels();
  const spend = ctx.spend();
  const pick = (chain: Parameters<typeof firstAvailableLite>[1]) => firstAvailableLite(models, chain);
  const lines = [
    `pi-jev-router-pro status`,
    `enabled: ${ctx.enabled()}${ctx.enabled() ? "" : " (set /jev-router on)"}`,
    `mode: ${ctx.mode()}`,
    `virtual model: ${ctx.virtualModelKey()}${ctx.isDormant() ? " · DORMANT (physical model selected; /jev auto to re-activate)" : ""}`,
    `active profile: ${runtime.getActiveProfileName() ?? "(none — built-in defaults)"}`,
    `jev model: ${config.jevModel}`,
    `api key: ${config.apiKeyEnv}${process.env[config.apiKeyEnv] ? " ✓" : " missing"}`,
    `spend today: ${formatUsd(spend.today)}${spend.dailyCap ? ` / ${formatUsd(spend.dailyCap)}` : ""}`,
    `spend month: ${formatUsd(spend.month)}${spend.monthlyCap ? ` / ${formatUsd(spend.monthlyCap)}` : ""}`,
    `budget pressure: ${spend.pressure > 0 ? `${(spend.pressure * 100).toFixed(0)}%` : "no caps set"}`,
    ctx.quotaLines().summary,
    `parking (TTL ${config.recovery.parkMs}ms):`,
    ...(runtime.parking.list().length ? runtime.parking.list().map((l) => `  ${l}`) : ["  (none)"]),
    `cache-aware: ${config.cache.aware ? `on (cap ${formatUsd(config.cache.maxPenaltyUsd)}, deadband ${config.cache.deadband})` : "off"}`,
    `built-in models: ${config.useDefaultModels ? "on" : "off (config-only)"}`,
    "",
    "routes:",
    ...TIERS.map((tier: Tier) => {
      const route = config.routes[tier];
      if (route.length === 0) return tier === "xpremium" ? `    ${tier.padEnd(9)} (off)` : `  ✗ ${tier.padEnd(9)} (none configured)`;
      const first = pick(route);
      const label = first ? `${first.provider}/${first.id}` : `${route[0]?.provider}/${route[0]?.model}`;
      const alts = route.length > 1 ? ` (+${route.length - 1} fallback${route.length > 2 ? "s" : ""})` : "";
      return `  ${first ? "✓" : "✗"} ${tier.padEnd(9)} ${label}${alts}`;
    }),
    "",
    `kind specialists (${Object.keys(config.kindModels).length}):`,
    ...Object.entries(config.kindModels).map(([kind, chain]) => `  ${kind.padEnd(10)} ${chain.map((t) => `${t.provider}/${t.model}${t.minTier ? ` (≥${t.minTier})` : ""}`).join(" → ") || "(empty)"}`),
    config.free.enabled
      ? `  free pool (${config.free.policy}, ${config.free.pool.length} configured) is tried ${config.free.policy === "prefer" ? "before these" : "after every tier"}`
      : "  free pool: off",
    "",
    ctx.lastDecision() ? `last: ${ctx.lastDecision()!.action} ${ctx.lastDecision()!.tier} → ${ctx.lastDecision()!.model.provider}/${ctx.lastDecision()!.model.id}` : "last: none",
    "",
    "commands: /jev profile … · /jev auto · /jev-router on|off|mode|parking|quota · /jev-route <text>",
  ];
  return lines.join("\n");
}

function firstAvailableLite(models: { provider: string; id: string }[], chain: { provider: string; model: string }[]): { provider: string; id: string } | undefined {
  for (const target of chain) {
    const model = models.find((m) => m.provider === target.provider && m.id === target.model) ?? models.find((m) => m.id === target.model);
    if (model) return model;
  }
  return undefined;
}

/** Register the whole command surface incl. legacy aliases (R8.3). */
export function registerCommands(pi: ExtensionAPI, ctx: ProCommandsContext, routePreview: import("./context.js").RoutePreview): void {
  const withCommand = (command: ExtensionCommandContext) => ({ ...ctx, command });

  pi.registerCommand("jev", {
    description: "Jev router pro: auto, profile CRUD, switching, help",
    handler: async (args, command) => {
      await handleJevCommand(args, withCommand(command));
    },
  });

  pi.registerCommand("jev-route", {
    description: "Ask Jev which model tier a request deserves (no switching)",
    handler: async (args, command) => {
      const text = args.trim();
      if (!text) {
        notify(command, "usage: /jev-route <text>", "warning");
        return;
      }
      const result = await routePreview.analyse(text, command);
      if (!result.ok) {
        notify(command, result.error ?? "classification failed", "warning");
        return;
      }
      notify(command, [result.analysisText, "", result.decisionText].join("\n"), "info");
    },
  });

  registerJevRouterCommand(pi, ctx);

  // Legacy aliases (R8.3).
  const alias = (name: string, description: string, handler: (argumentText: string, command: ExtensionCommandContext) => Promise<void>) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, command) => {
        await handler(args, command);
      },
    });
  };
  alias("jev-profile", "Switch or manage the active Jev routing profile (alias of /jev profile)", async (args, command) => {
    await handleJevCommand(args ? `profile ${args}` : "profile", withCommand(command));
  });
  alias("jev-profiles", "List Jev routing profiles and switch (alias)", async (args, command) => {
    await handleProfileList(args, withCommand(command));
  });
  alias("jev-profile-current", "Show the currently active Jev routing profile (alias)", async (_args, command) => {
    await handleProfileCurrent("", withCommand(command));
  });
  alias("jev-profile-show", "Show configuration details of a Jev routing profile (alias)", async (args, command) => {
    await handleProfileShow(args, withCommand(command));
  });
  alias("jev-profile-add", "Create a new Jev routing profile (alias)", async (args, command) => {
    await handleProfileAdd(args, withCommand(command));
  });
  alias("jev-profile-save", "Save the active routing configuration as a profile (alias)", async (args, command) => {
    await handleProfileSave(args, withCommand(command));
  });
  alias("jev-profile-edit", "Edit an existing Jev routing profile (alias)", async (args, command) => {
    await handleProfileEdit(args, withCommand(command));
  });
  alias("jev-profile-clone", "Clone an existing Jev routing profile (alias)", async (args, command) => {
    await handleProfileClone(args, withCommand(command));
  });
  alias("jev-profile-remove", "Permanently delete a Jev routing profile (alias)", async (args, command) => {
    await handleProfileRemove(args, withCommand(command));
  });
  alias("jev-profile-reload", "Reload Jev routing profiles from disk (alias)", async (args, command) => {
    await handleProfileReload(args, withCommand(command));
  });
  alias("jev-profile-init", "Initialize starter Jev routing profiles if missing (alias)", async (args, command) => {
    await handleProfileInit(args, withCommand(command));
  });
}
