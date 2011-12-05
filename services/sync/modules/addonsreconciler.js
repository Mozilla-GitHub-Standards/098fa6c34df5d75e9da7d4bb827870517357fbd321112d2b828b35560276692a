/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Firefox Sync.
 *
 * The Initial Developer of the Original Code is
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Gregory Szorc <gps@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * This file contains middleware to reconcile state of AddonManager for
 * purposes of tracking events for Sync. The content in this file exists
 * because AddonManager does not have a getChangesSinceX() API and adding
 * that functionality properly was deemed too time-consuming at the time
 * add-on sync was originally written. If/when AddonManager adds this API,
 * this file can go away and the add-ons engine can be rewritten to use it.
 *
 * It was decided to have this tracking functionality exist in a separate
 * standalone file so it could be more easily understood, tested, and
 * hopefully ported.
 */

"use strict";

const Cu = Components.utils;

Cu.import("resource://services-sync/log4moz.js");
Cu.import("resource://services-sync/util.js");
Cu.import("resource://gre/modules/AddonManager.jsm");

const DEFAULT_STATE_FILE = "addonsreconciler";

const CHANGE_INSTALLED = 1;
const CHANGE_UNINSTALLED = 2;
const CHANGE_ENABLED = 3;
const CHANGE_DISABLED = 4;

const EXPORTED_SYMBOLS = ["AddonsReconciler", "CHANGE_INSTALLED",
                          "CHANGE_UNINSTALLED", "CHANGE_ENABLED",
                          "CHANGE_DISABLED"];
/**
 * Maintains state of add-ons.
 *
 * State is maintained in 2 data structures, an object mapping add-on IDs
 * to metadata and an array of changes over time. The object mapping can be
 * thought of as a minimal copy of data from AddonManager which is needed for
 * Sync. The array is effectively a log of changes over time.
 *
 * The data structures are persisted to disk by serializing to a JSON file in
 * the current profile. The data structures are updated by 2 mechanisms. First,
 * they can be refreshed from the global state of the AddonManager. This is a
 * sure-fire way of ensuring the reconciler is up to date. Second, the
 * reconciler adds itself as an AddonManager listener. When it receives change
 * notifications, it updates its internal state incrementally.
 *
 * The internal state is persisted to a JSON file in the profile directory.
 *
 * An instance of this is bound to an AddonsEngine instance. In reality, it
 * likely exists as a singleton. To AddonsEngine, it functions as a store and
 * an entity which emits events for tracking.
 *
 * The usage pattern for instances of this class is:
 *
 *   let reconciler = new AddonsReconciler();
 *   reconciler.loadState(null, function(error) { ... });
 *
 *   // At this point, your instance should be ready to use.
 *
 * When you are finished with the instance, please call:
 *
 *   reconciler.stopListening();
 *   reconciler.saveStateFile(...);
 *
 *
 * There are 2 classes of listeners in the AddonManager: AddonListener and
 * InstallListener. This class is a listener for both (member functions just
 * get called directly).
 *
 * When an add-on is installed, listeners are called in the following order:
 *
 *  IL.onInstallStarted, AL.onInstalling, IL.onInstallEnded, AL.onInstalled
 *
 * For non-restartless add-ons, an application restart may occur between
 * IL.onInstallEnded and AL.onInstalled. Unfortunately, Sync likely will
 * not be loaded when AL.onInstalled is fired shortly after application
 * start, so it won't see this event. Therefore, for add-ons requiring a
 * restart, Sync treats the IL.onInstallEnded event as good enough to
 * indicate an install. For restartless add-ons, Sync assumes AL.onInstalled
 * will follow shortly after IL.onInstallEnded and thus it ignores
 * IL.onInstallEnded.
 *
 * The listeners can also see events related to the download of the add-on.
 * This class isn't interested in those. However, there are failure events,
 * IL.onDownloadFailed and IL.onDownloadCanceled which get called if a
 * download doesn't complete successfully.
 *
 * For uninstalls, we see AL.onUninstalling then AL.onUninstalled. Like
 * installs, the events could be separated by an application restart and Sync
 * may not see the onUninstalled event. Again, if we require a restart, we
 * react to onUninstalling. If not, we assume we'll get onUninstalled.
 *
 * Enabling and disabling work by sending:
 *
 *   AL.onEnabling, AL.onEnabled
 *   AL.onDisabling, AL.onDisabled
 *
 * Again, they may be separated by a restart, so we heed the requiresRestart
 * flag.
 *
 * Actions can be undone. All undoable actions notify the same
 * AL.onOperationCancelled event. We treat this event like any other.
 *
 * Restartless add-ons have interesting behavior during uninstall. These
 * add-ons are first disabled then they are actually uninstalled. So, we will
 * see AL.onDisabling and AL.onDisabled. The onUninstalling and onUninstalled
 * events only come after the Addon Manager is closed or another view is
 * switched to. In the case of Sync performing the uninstall, the uninstall
 * events will occur immediately. However, we still see disabling events and
 * heed them like they were normal. In the end, the state is proper.
 */
function AddonsReconciler() {
  this._log = Log4Moz.repository.getLogger("Sync.AddonsReconciler");
  let level = Svc.Prefs.get("log.logger.addonsreconciler", "Debug");
  this._log.level = Log4Moz.Level[level];

  AddonManager.addAddonListener(this);
  AddonManager.addInstallListener(this);
  this._listening = true;

  Svc.Obs.add("xpcom-shutdown", this.stopListening.bind(this));
};
AddonsReconciler.prototype = {
  /** Flag indicating whether we are listening to AddonManager events. */
  _listening: false,

  /** log4moz logger instance */
  _log: null,

  /**
   * This is the main data structure for an instance.
   *
   * Keys are add-on IDs. Values are objects which describe the state of the
   * add-on.
   */
  _addons: {},

  /**
   * List of add-on changes over time.
   *
   * Each element is an array of [time, change, id].
   */
  _changes: [],

  _listeners: [],

  get addons() {
    return this._addons;
  },

  /**
   * Loads reconciler state from a file.
   *
   * The path is relative to the weave directory in the profile. If no
   * path is given, the default one is used.
   *
   * @param path
   *        Path to load. ".json" is appended automatically.
   * @param callback
   *        Callback to be executed upon file load. The callback receives a
   *        truthy error argument signifying whether an error occurred and a
   *        boolean indicating whether data was loaded.
   */
  loadState: function loadState(path, callback) {
    let file = path || DEFAULT_STATE_FILE;
    Utils.jsonLoad(file, this, function(json) {
      this._addons = {};
      this._changes = [];

      if (json != undefined) {
        let version = json.version;
        if (!version || version != 1) {
          this._log.error("Could not load JSON file because version not " +
                          "supported: " + version);
          callback(null, false);
        }

        this._addons = json.addons;
        for each (let record in this._addons) {
          record.modified = new Date(record.modified);
        }

        for each (let change in json.changes) {
          this._changes.push([new Date(change[0]), change[1], change[2]]);
        }

        if (callback) {
          callback(null, true);
        }
      } else {
        if (callback) {
          callback(null, false);
        }
      }
    });
  },

  /**
   * Saves the state to a file in the local profile.
   *
   * @param  path
   *         String path in profile to save to. If not defined, the default
   *         will be used.
   * @param  callback
   *         Function to be invoked on save completion. No parameters will be
   *         passed to callback.
   */
  saveState: function saveState(path, callback) {
    let state = {version: 1, addons: {}, changes: []};

    for (let [id, record] in Iterator(this._addons)) {
      state[id] = {};
      for (let [k, v] in Iterator(record)) {
        if (k == "modified") {
          state[id][k] = v.getTime();
        }
        else {
          state[id][k] = v;
        }
      }
    }

    for each (let change in this._changes) {
      state.changes.push([change[0].getTime(), change[1], change[2]]);
    }

    Utils.jsonSave(path || DEFAULT_STATE_FILE, this, state, callback);
  },

  /**
   * Registers a change listener with this instance.
   *
   * Change listeners are called every time a change is recorded. The listener
   * should be a function that takes 3 arguments, the Date at which the change
   * happened, the type of change (a CHANGE_* constant), and the add-on state
   * object reflecting the current state of the add-on at the time of the
   * change.
   */
  addChangeListener: function addChangeListener(listener) {
    if (!this._listeners.some(function(i) { return i == listener; })) {
      this._log.debug("Adding change listener.");
      this._listeners.push(listener);
    }
  },

  /**
   * Removes a previously-installed change listener from the instance.
   */
  removeChangeListener: function removeChangeListener(listener) {
    this._listeners = this._listeners.filter(function(element) {
      if (element == listener) {
        this._log.debug("Removing change listener.");
        return false;
      } else {
        return true;
      }
    }.bind(this));
  },

  /**
   * Tells the instance to stop listening for AddonManager changes.
   *
   * The reconciler should always be listening. This should only be called when
   * the instance is being destroyed.
   */
  stopListening: function stopListening() {
    if (this._listening) {
      AddonManager.removeInstallListener(this);
      AddonManager.removeAddonListener(this);
      this._listening = false;
    }
  },

  /**
   * Refreshes the global state of add-ons by querying the AddonsManager.
   */
  refreshGlobalState: function refreshGlobalState(callback) {
    this._log.info("Refreshing global state from AddonManager.");
    AddonManager.getAllAddons(function (addons) {
      let ids = {};

      for each (let addon in addons) {
        ids[addon.id] = true;
        this.rectifyStateFromAddon(addon);
      }

      // Look for locally-defined add-ons that don't exist any more and update
      // their record
      for (let [id, addon] in Iterator(this._addons)) {
        if (id in ids) {
          continue;
        }

        // If the id isn't in ids, it means that the add-on has been deleted.
        if (addon.installed) {
          addon.installed = false;
          this.addChange(new Date(), CHANGE_UNINSTALLED, addon);
        }
      }

      this.saveState(null, callback);
    }.bind(this));
  },

  /**
   * Rectifies the state of an add-on from an add-on instance.
   *
   * @param addon
   *        Addon instance being updated.
   */
  rectifyStateFromAddon: function rectifyStateFromAddon(addon) {
    this._log.debug("Rectifying state for addon: " + addon.id);

    let id = addon.id;
    let enabled = !addon.userDisabled;
    let guid = addon.syncGUID;
    let now = new Date();

    if (!(id in this._addons)) {
      let record = {
        id: id,
        guid: guid,
        enabled: enabled,
        installed: true,
        modified: now,
        type: addon.type,
        scope: addon.scope,
        foreignInstall: addon.foreignInstall
      };
      this._addons[id] = record;
      this.addChange(now, CHANGE_INSTALLED, record);
      return;
    }

    let record = this._addons[id];

    if (!record.installed) {
      record.installed = true;
      record.modified = now;
    }

    if (record.enabled != enabled) {
      record.enabled = enabled;
      record.modified = now;
      let change = enabled ? CHANGE_ENABLED : CHANGE_DISABLED;
      this.addChange(new Date(), change, record);
    }

    if (record.guid != guid) {
      record.guid = guid;
      // We don't record a change because the Sync engine rectifies this on its
      // own.
    }
  },

  addChange: function addChange(date, change, addon) {
    this._log.info("Change recorded for " + addon.id);
    this._changes.push([date, change, addon.id]);

    for each (let listener in this._listeners) {
      try {
        listener.changeListener.call(listener, date, change, addon);
      } catch (ex) {
        this._log.warn("Exception calling change listener: " +
                       Utils.exceptionStr(ex));
      }
    }
  },

  /**
   * Obtain the set of changes to add-ons since the date passed.
   *
   * This will return an array of arrays. Each entry in the array has the
   * elements [time, change_type, id], where
   *
   *   date - Date instance representing when the change occurred
   *   change_type - One of CHANGE_* constants.
   */
  getChangesSinceDate: function getChangesSinceDate(date) {
    let length = this._changes.length;
    for (let i = 0; i < length; i++) {
      let entry = this._changes[i];

      if (entry[0] < date) {
        continue;
      }

      return this._changes.slice(i);
    }

    return [];
  },

  /**
   * Prunes all recorded changes from before the specified Date.
   *
   * @param date
   *        Entries older than this Date will be removed.
   */
  pruneChangesBeforeDate: function pruneChangesBeforeDate(date) {
    while (this._changes.length > 0) {
      let entry = this._changes[0];

      if (entry[0] < date) {
        delete this._changes[0];
      } else {
        return;
      }
    }
  },

  /**
   * Obtains the set of all known Sync GUIDs for add-ons.
   *
   * @return Object with guids as keys and values of true.
   */
  getAllSyncGUIDs: function getAllSyncGUIDs() {
    let result = {};
    for (let id in this._addons) {
      result[id] = true;
    }

    return result;
  },

  /**
   * Obtain the add-on state record for an add-on by Sync GUID.
   *
   * If the add-on could not be found, returns null.
   *
   * @param  guid
   *         Sync GUID of add-on to retrieve.
   * @return Object on success on null on failure.
   */
  getAddonStateFromSyncGUID: function getAddonStateFromSyncGUID(guid) {
    for each (let addon in this._addons) {
      if (addon.guid == guid) {
        return addon;
      }
    }

    return null;
  },

  /**
   * Handler that is invoked as part of the AddonManager listeners.
   */
  _handleListener: function _handlerListener(action, addon, requiresRestart) {
    // Since this is called as an observer, we explicitly trap errors and
    // log them to ourselves so we don't see errors reported elsewhere.
    try {
      let id = addon.id;
      this._log.debug("Add-on change: " + action + " to " + id);

      // We assume that every event for non-restartless add-ons is
      // followed by another event and that this follow-up event is the most
      // appropriate to react to. Currently we ignore onEnabling, onDisabling,
      // and onUninstalling for non-restartless add-ons.
      if (requiresRestart === false) {
        this._log.debug("Ignoring notification because restartless");
        return;
      }

      switch (action) {
        case "onEnabling":
        case "onEnabled":
        case "onDisabling":
        case "onDisabled":
        case "onInstalled":
        case "onOperationCancelled":
          this.rectifyStateFromAddon(addon);
          break;

        case "onUninstalling":
        case "onUninstalled":
          let id = addon.id;
          if (id in this._addons) {
            let now = new Date();
            let record = this._addons[id];
            record.installed = false;
            record.modified = now;
            this.addChange(now, CHANGE_UNINSTALLED, record);
          }
      }

      this.saveState(null, null);
    }
    catch (ex) {
      this._log.warn("Exception: " + Utils.exceptionStr(ex));
    }
  },

  // AddonListeners
  onEnabling: function onEnabling(addon, requiresRestart) {
    this._handleListener("onEnabling", addon, requiresRestart);
  },
  onEnabled: function onEnabled(addon) {
    this._handleListener("onEnabled", addon);
  },
  onDisabling: function onDisabling(addon, requiresRestart) {
    this._handleListener("onDisabling", addon, requiresRestart);
  },
  onDisabled: function onDisabled(addon) {
    this._handleListener("onDisabled", addon);
  },
  onInstalling: function onInstalling(addon, requiresRestart) {
    this._handleListener("onInstalling", addon, requiresRestart);
  },
  onInstalled: function onInstalled(addon) {
    this._handleListener("onInstalled", addon);
  },
  onUninstalling: function onUninstalling(addon, requiresRestart) {
    this._handleListener("onUninstalling", addon, requiresRestart);
  },
  onUninstalled: function onUninstalled(addon) {
    this._handleListener("onUninstalled", addon);
  },
  onOperationCancelled: function onOperationCancelled(addon) {
    this._handleListener("onOperationCancelled", addon);
  },

  // InstallListeners
  onInstallEnded: function onInstallEnded(install, addon) {
    this._handleListener("onInstallEnded", addon);
  }
};
