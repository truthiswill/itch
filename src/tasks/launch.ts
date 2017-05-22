
import {EventEmitter} from "events";

import fnout from "fnout";
import * as ospath from "path";
import * as toml from "toml";

import * as invariant from "invariant";

import validateManifest from "./launch/validate-manifest";

import nativePrepare from "./prepare/native";

import nativeLaunch from "./launch/native";
import htmlLaunch from "./launch/html";
import shellLaunch from "./launch/shell";
import externalLaunch from "./launch/external";

import store from "../store/metal-store";
import * as actions from "../actions";
import {startTask} from "../reactors/tasks/start-task";

import {app, powerSaveBlocker} from "electron";

import api from "../api";
import * as os from "../os";
import sf from "../os/sf";
import * as paths from "../os/paths";
import explorer from "../os/explorer";
import diego from "../os/diego";

import fetch from "../util/fetch";
import defaultManifestIcons from "../constants/default-manifest-icons";

import actionForGame from "../util/action-for-game";

import {promisedModal} from "../reactors/modals";
import {MODAL_RESPONSE} from "../constants/action-types";

import {findWhere, each} from "underscore";

import localizer from "../localizer";

import {Crash, Cancelled} from "./errors";

import {
  IModalButtonSpec, ICaveRecord, IStartTaskOpts, ILaunchOpts, IGameRecord,
  IManifest, IManifestAction, IEnvironment,
} from "../types";

interface ILauncher {
  (out: EventEmitter, opts: ILaunchOpts): Promise<void>;
}

interface ILaunchers {
  [key: string]: ILauncher;
}

interface IPrepareOpts extends ILaunchOpts {
  manifest: IManifest;
}

interface IPrepare {
  (out: EventEmitter, opts: IPrepareOpts): Promise<void>;
}

interface IPrepares {
  [key: string]: IPrepare;
}

function caveProblem (cave: ICaveRecord) {
  switch (cave.launchType) {
    case "native":
      // FIXME: this isn't an issue if we have a manifest
      if (!cave.executables || cave.executables.length === 0) {
        return ["game.install.no_executables_found"];
      }
      break;
    case "html":
      if (!cave.gamePath) {
        return ["game.install.no_html_index_found"];
      }
      break;
    default:
      break;
  }
}

export default async function start (out: EventEmitter, inOpts: IStartTaskOpts) {
  const {cave} = inOpts;

  const logger = paths.caveLogger(cave.id);
  let opts = {
    ...inOpts,
    logger,
  };

  try {
    return await doStart(out, opts);
  } catch (e) {
    const {market, credentials} = opts;
    const game = await fetch.gameLazily(market, credentials, cave.gameId, {game: cave.game});

    logger.error(`crashed with ${e.message}`);
    logger.error(`${e.message || e}`);
    await diego.hire(opts);

    const i18n = store.getState().i18n;
    const t = localizer.getT(i18n.strings, i18n.lang);

    let errorMessage = String(e);
    if (e.reason) {
      if (Array.isArray(e.reason)) {
        errorMessage = t.format(e.reason);
      } else {
        errorMessage = String(e.reason);
      }
    }

    store.dispatch(actions.openModal({
      title: "",
      message: ["game.install.could_not_launch", {title: game.title}],
      detail: errorMessage,
      buttons: [
        {
          label: ["grid.item.report_problem"],
          icon: "upload-to-cloud",
          action: actions.reportCave({caveId: cave.id}),
        },
        {
          label: ["grid.item.probe"],
          icon: "bug",
          className: "secondary",
          action: actions.probeCave({caveId: cave.id}),
        },
        "cancel",
      ],
    }));
  } finally {
    logger.close();
  }
}

export async function doStart (out: EventEmitter, opts: IStartTaskOpts) {
  const {globalMarket, market, credentials, logger} = opts;
  let {cave} = opts;
  invariant(cave, "launch has cave");
  invariant(globalMarket, "launch has globalMarket");
  invariant(credentials, "launch has credentials");
  invariant(market, "launch has market");

  const launchOpts = {...opts, store};

  const game = await fetch.gameLazily(market, credentials, cave.gameId, {game: cave.game});
  const caveGame = (cave.game || {}) as IGameRecord;

  const action = actionForGame(caveGame, cave);
  if (action === "open") {
    globalMarket.saveEntity("caves", cave.id, {lastTouched: Date.now()});
    explorer.open(paths.appPath(cave, store.getState().preferences));
    return;
  }

  let {launchType = "native"} = cave;

  let problem = caveProblem(cave);
  if (problem) {
    logger.warn(`reconfiguring because of problem with cave: ${problem}`);
    await startTask(store, {
      name: "configure",
      gameId: game.id,
      game,
      cave,
      upload: cave.uploads[cave.uploadId],
    });
    cave = globalMarket.getEntities<ICaveRecord>("caves")[cave.id];
  }

  problem = caveProblem(cave);
  if (problem) {
    // FIXME: this swallows the problem.
    const err = new Error(`The game could not be configured (${problem})`) as Error;
    (err as any).reason = problem;
    throw err;
  }

  logger.info(`itch ${app.getVersion()} launching game ${game.id}: ${game.title}`);

  const env: IEnvironment = {};
  const args: string[] = [];
  const appPath = paths.appPath(cave, store.getState().preferences);
  const manifestPath = ospath.join(appPath, ".itch.toml");
  logger.info(`looking for manifest @ "${manifestPath}"`);
  const hasManifest = await sf.exists(manifestPath);
  let manifestAction: IManifestAction;
  let manifest: IManifest;

  if (hasManifest) {
    logger.info("found manifest, parsing");

    try {
      const contents = await sf.readFile(manifestPath, {encoding: "utf8"});
      manifest = toml.parse(contents);
    } catch (e) {
      logger.error(`error reading manifest: ${e}`);
      throw e;
    }

    logger.info(`manifest:\n ${JSON.stringify(manifest, null, 2)}`);
    validateManifest(manifest, launchOpts.logger);

    if (manifest.actions.length > 1) {
      const buttons: IModalButtonSpec[] = [];
      const bigButtons: IModalButtonSpec[] = [];
      each(manifest.actions, (actionOption, i) => {
        if (!actionOption.name) {
          throw new Error(`in manifest, action ${i} is missing a name`);
        }
        bigButtons.push({
          label: [`action.name.${actionOption.name}`, {defaultValue: actionOption.name}],
          action: actions.modalResponse({manifestActionName: actionOption.name}),
          icon: actionOption.icon || defaultManifestIcons[actionOption.name] || "star",
          className: `action-${actionOption.name}`,
        });
      });

      buttons.push("cancel");

      const response = await promisedModal(store, {
        title: game.title,
        cover: game.stillCoverUrl || game.coverUrl,
        message: "",
        bigButtons,
        buttons,
      });

      if (response.type === MODAL_RESPONSE) {
        manifestAction = findWhere(manifest.actions, {name: response.payload.manifestActionName});
      } else {
        return; // cancelled by user
      }
    } else {
      manifestAction = manifest.actions[0];
    }
  } else {
    logger.info("No manifest found (no \'.itch.toml\' file in top-level directory). Proceeding with heuristics.");
  }

  if (manifestAction) {
    manifestAction.path = manifestAction.path.replace(/{{EXT}}/, appExt());
    launchType = await launchTypeForAction(appPath, manifestAction.path);

    if (manifestAction.scope) {
      logger.info(`Requesting subkey with scope: ${manifestAction.scope}`);
      const client = api.withKey(credentials.key);
      const subkey = await client.subkey(game.id, manifestAction.scope);
      logger.info(`Got subkey (${subkey.key.length} chars, expires ${subkey.expiresAt})`);
      (env as any).ITCHIO_API_KEY = subkey.key;
      (env as any).ITCHIO_API_KEY_EXPIRES_AT = subkey.expiresAt;
    }

    if (manifestAction.args) {
      each(manifestAction.args, (arg) => {
        args.push(arg);
      });
    }
  }

  launchOpts.manifestAction = manifestAction;
  launchOpts.env = env;
  launchOpts.args = args;

  const launchers = {
    native: nativeLaunch,
    html: htmlLaunch,
    shell: shellLaunch,
    external: externalLaunch,
  } as ILaunchers;
  const launcher = launchers[launchType];
  if (!launcher) {
    throw new Error(`Unsupported launch type '${cave.launchType}'`);
  }

  const prepares = {
    native: nativePrepare,
  } as IPrepares;
  const prepare = prepares[launchType];
  if (prepare) {
    logger.info(`launching prepare for ${launchType}`);
    await prepare(out, {...launchOpts, manifest});
  } else {
    logger.info(`no prepare for ${launchType}`);
  }

  const startedAt = Date.now();
  globalMarket.saveEntity("caves", cave.id, {lastTouched: startedAt});

  let interval: NodeJS.Timer;
  const UPDATE_PLAYTIME_INTERVAL = 10;
  let powerSaveBlockerId = null;
  try {
    interval = setInterval(() => {
      const now = Date.now();
      const previousSecondsRun = globalMarket.getEntity<ICaveRecord>("caves", cave.id).secondsRun || 0;
      const newSecondsRun = UPDATE_PLAYTIME_INTERVAL + previousSecondsRun;
      globalMarket.saveEntity("caves", cave.id, {secondsRun: newSecondsRun, lastTouched: now});
    }, UPDATE_PLAYTIME_INTERVAL * 1000) as any as NodeJS.Timer;

    powerSaveBlockerId = opts.preferences.preventDisplaySleep ? powerSaveBlocker.start("prevent-display-sleep") : null;

    await launcher(out, launchOpts);

  } catch (e) {
    logger.error(`error while launching ${cave.id}: ${e.message || e}`);
    if (e instanceof Crash) {
      const secondsRunning = (Date.now() - startedAt) / 1000;
      if (secondsRunning > 2) {
        // looks like the game actually launched fine!
        logger.warn(`Game was running for ${secondsRunning} seconds, ignoring: ${e.toString()}`);
        return;
      }
    }

    if (e instanceof Cancelled) {
      // all good then
      return;
    }

    throw e;
  } finally {
    clearInterval(interval);
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId);
    }
    const now = Date.now();
    globalMarket.saveEntity("caves", cave.id, {lastTouched: now});
  }
}

async function launchTypeForAction (appPath: string, actionPath: string) {
  if (/\.(app|exe|bat|sh)$/i.test(actionPath)) {
    return "native";
  }

  if (/\.html?$/i.test(actionPath)) {
    return "html";
  }

  if (/^https?:/i.test(actionPath)) {
    return "external";
  }

  const platform = os.itchPlatform();

  const fullPath = ospath.join(appPath, actionPath);
  const sniffRes = await fnout.path(fullPath);
  if ((sniffRes.linuxExecutable && platform === "linux") ||
      (sniffRes.macExecutable && platform === "osx")) {
    return "native";
  }

  return "shell";
}

function appExt () {
  switch (os.itchPlatform()) {
    case "osx": return ".app";
    case "windows": return ".exe";
    default: return "";
  }
}
