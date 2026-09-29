// ../../scripts/mcp-sync-smoke/main.ts
import { app as app3, BrowserWindow as BrowserWindow2, ipcMain } from "electron";
import path7 from "node:path";
import os from "node:os";
import fs3 from "node:fs";

// src/main/store/db.ts
import { app as app2 } from "electron";
import Database from "better-sqlite3";
import { join as join2 } from "node:path";
import { copyFileSync, existsSync } from "node:fs";

// src/main/lib/logger.ts
import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
var logFile = null;
function getLogFile() {
  if (logFile) return logFile;
  const dir = join(app.getPath("userData"), "logs");
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, "main.log");
  return logFile;
}
function write(level, msg) {
  const line = `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${msg}
`;
  try {
    process.stderr.write(line);
  } catch {
  }
  try {
    appendFileSync(getLogFile(), line);
  } catch {
  }
}
var log = {
  info: (msg) => write("INFO", msg),
  warn: (msg) => write("WARN", msg),
  error: (msg) => write("ERROR", msg)
};

// src/main/store/db.ts
var db = null;
var dbPath = null;
var dbReadyPromise = null;
function awaitDb() {
  return dbReadyPromise ?? Promise.resolve();
}
function backupOnceBeforeMigration(path8) {
  const backupPath = `${path8}.sqljs-era.bak`;
  if (existsSync(backupPath)) return;
  try {
    copyFileSync(path8, backupPath);
    log.info(`sqlite: one-time pre-migration backup written: ${backupPath}`);
  } catch (err) {
    log.warn(`sqlite: pre-migration backup failed (continuing): ${err.message}`);
  }
}
function initDb() {
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise.then(() => db);
  dbReadyPromise = (async () => {
    dbPath = join2(app2.getPath("userData"), "claude-gui.db");
    if (existsSync(dbPath)) backupOnceBeforeMigration(dbPath);
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    log.info(`sqlite opened (better-sqlite3, WAL): ${dbPath}`);
  })();
  return dbReadyPromise.then(() => db);
}
function getDb() {
  if (!db) throw new Error("getDb() called before initDb() resolved");
  return db;
}
function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id       TEXT NOT NULL DEFAULT 'claude-sdk',
      claude_session_id TEXT,
      title             TEXT NOT NULL,
      status            TEXT NOT NULL,
      model             TEXT NOT NULL,
      effort            TEXT NOT NULL DEFAULT 'default',
      permission_mode   TEXT NOT NULL,
      custom_model_id   TEXT,
      archived          INTEGER NOT NULL DEFAULT 0,
      pinned_at         INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider_id     TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      schedule_kind   TEXT NOT NULL,
      time_of_day     TEXT,
      weekdays        TEXT NOT NULL DEFAULT '[]',
      run_at          TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      push_enabled    INTEGER NOT NULL DEFAULT 0,
      next_run_at     INTEGER,
      last_run_at     INTEGER,
      last_status     TEXT NOT NULL DEFAULT 'idle',
      last_error      TEXT,
      last_session_id TEXT,
      last_push_status TEXT NOT NULL DEFAULT 'idle',
      last_push_at     INTEGER,
      last_push_error  TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project
      ON scheduled_tasks(project_id);

    CREATE TABLE IF NOT EXISTS clawbot_conversations (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL,
      peer_key            TEXT NOT NULL,
      project_id          TEXT,
      session_id          TEXT,
      provider_id         TEXT NOT NULL,
      model               TEXT NOT NULL,
      permission_mode     TEXT NOT NULL,
      state               TEXT NOT NULL DEFAULT 'active',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE(account_id, peer_key)
    );

    CREATE TABLE IF NOT EXISTS clawbot_inbox (
      id                        TEXT PRIMARY KEY,
      account_id                TEXT NOT NULL,
      external_message_id       TEXT NOT NULL,
      peer_key                  TEXT NOT NULL,
      reply_context_ref         TEXT NOT NULL,
      payload_ciphertext        TEXT NOT NULL,
      conversation_id           TEXT REFERENCES clawbot_conversations(id),
      status                    TEXT NOT NULL DEFAULT 'queued',
      attempt_count             INTEGER NOT NULL DEFAULT 0,
      received_at               INTEGER NOT NULL,
      claimed_at                INTEGER,
      completed_at              INTEGER,
      last_error                TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL,
      UNIQUE(account_id, external_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_clawbot_inbox_claim
      ON clawbot_inbox(conversation_id, status, received_at, id);

    CREATE TABLE IF NOT EXISTS clawbot_outbox (
      id                        TEXT PRIMARY KEY,
      inbox_id                  TEXT NOT NULL REFERENCES clawbot_inbox(id),
      conversation_id           TEXT NOT NULL REFERENCES clawbot_conversations(id),
      client_id                 TEXT NOT NULL UNIQUE,
      reply_context_ref         TEXT NOT NULL,
      payload_ciphertext        TEXT NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'queued',
      sent_at                   INTEGER,
      last_error                TEXT,
      created_at                INTEGER NOT NULL,
      updated_at                INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clawbot_outbox_status
      ON clawbot_outbox(status, created_at, id);
  `);
  addColumnIfMissing(database, "sessions", "effort", "TEXT NOT NULL DEFAULT 'default'");
  addColumnIfMissing(database, "sessions", "provider_id", "TEXT NOT NULL DEFAULT 'claude-sdk'");
  addColumnIfMissing(database, "sessions", "context_snapshot", "TEXT");
  addColumnIfMissing(database, "sessions", "todos", "TEXT");
  addColumnIfMissing(database, "sessions", "subagents", "TEXT");
  addColumnIfMissing(database, "sessions", "plan_draft", "TEXT");
  addColumnIfMissing(database, "sessions", "custom_model_id", "TEXT");
  addColumnIfMissing(database, "sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "sessions", "pinned_at", "INTEGER");
  addColumnIfMissing(database, "sessions", "turn_files", "TEXT");
  addColumnIfMissing(database, "sessions", "bookmarks", "TEXT");
  addColumnIfMissing(database, "sessions", "subagent_transcripts", "TEXT");
  addColumnIfMissing(database, "sessions", "usage_history", "TEXT");
  addColumnIfMissing(database, "sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'");
  addColumnIfMissing(database, "sessions", "parent_session_id", "TEXT");
  addColumnIfMissing(database, "sessions", "env_mode", "TEXT NOT NULL DEFAULT 'local'");
  addColumnIfMissing(database, "sessions", "worktree_path", "TEXT");
  addColumnIfMissing(database, "sessions", "wt_style", "TEXT");
  addColumnIfMissing(database, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "projects", "group", "TEXT");
  addColumnIfMissing(database, "projects", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "projects", "pinned_at", "INTEGER");
  addColumnIfMissing(database, "scheduled_tasks", "push_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "scheduled_tasks", "last_push_status", "TEXT NOT NULL DEFAULT 'idle'");
  addColumnIfMissing(database, "scheduled_tasks", "last_push_at", "INTEGER");
  addColumnIfMissing(database, "scheduled_tasks", "last_push_error", "TEXT");
  addColumnIfMissing(database, "clawbot_inbox", "reply_context_ref", "TEXT");
  addColumnIfMissing(database, "clawbot_outbox", "reply_context_ref", "TEXT");
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)"
  );
  database.exec(
    "DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)"
  );
}
function addColumnIfMissing(database, table, column, def) {
  const found = database.prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?").all(table, column);
  if (found.length === 0) {
    database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${def}`);
  }
}
function persist() {
}

// src/main/ipc/mcp.ts
import { existsSync as existsSync12, readFileSync as readFileSync4, writeFileSync } from "node:fs";
import path6 from "node:path";
import { spawnSync } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { userInfo } from "node:os";

// src/main/terminal/TerminalManager.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync5, statSync, chmodSync } from "node:fs";
import { dirname as dirname2, join as join5 } from "node:path";
import { createRequire } from "node:module";

// ../../node_modules/.pnpm/zod@3.24.0/node_modules/zod/lib/index.mjs
var util;
(function(util2) {
  util2.assertEqual = (val) => val;
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  get errors() {
    return this.issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
        fieldErrors[sub.path[0]].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var overrideErrorMap = errorMap;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
var makeIssue = (params) => {
  const { data, path: path8, errorMaps, issueData } = params;
  const fullPath = [...path8, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message === null || message === void 0 ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));
var _ZodEnum_cache;
var _ZodNativeEnum_cache;
var ParseInputLazyPath = class {
  constructor(parent, value, path8, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path8;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (this._key instanceof Array) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    var _a, _b;
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message !== null && message !== void 0 ? message : ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: (_a = message !== null && message !== void 0 ? message : required_error) !== null && _a !== void 0 ? _a : ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: (_b = message !== null && message !== void 0 ? message : invalid_type_error) !== null && _b !== void 0 ? _b : ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    var _a;
    const ctx = {
      common: {
        issues: [],
        async: (_a = params === null || params === void 0 ? void 0 : params.async) !== null && _a !== void 0 ? _a : false,
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    var _a, _b, _c;
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if ((_c = (_b = (_a = err) === null || _a === void 0 ? void 0 : _a.message) === null || _b === void 0 ? void 0 : _b.toLowerCase()) === null || _c === void 0 ? void 0 : _c.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap,
        async: true
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let regex = `([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d`;
  if (args.precision) {
    regex = `${regex}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    regex = `${regex}(\\.\\d+)?`;
  }
  return regex;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if (!decoded.typ || !decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch (_a) {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch (_a) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({ kind: "base64url", ...errorUtil.errToObj(message) });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    var _a, _b;
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      offset: (_a = options === null || options === void 0 ? void 0 : options.offset) !== null && _a !== void 0 ? _a : false,
      local: (_b = options === null || options === void 0 ? void 0 : options.local) !== null && _b !== void 0 ? _b : false,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options === null || options === void 0 ? void 0 : options.position,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * @deprecated Use z.string().min(1) instead.
   * @see {@link ZodString.min}
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  var _a;
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (_a = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a !== void 0 ? _a : false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / Math.pow(10, decCount);
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null, min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch (_a) {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  var _a;
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (_a = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a !== void 0 ? _a : false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    return this._cached = { shape, keys };
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a, _b, _c, _d;
          const defaultError = (_c = (_b = (_a = this._def).errorMap) === null || _b === void 0 ? void 0 : _b.call(_a, issue, ctx).message) !== null && _c !== void 0 ? _c : ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: (_d = errorUtil.errToObj(message).message) !== null && _d !== void 0 ? _d : defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    util.objectKeys(mask).forEach((key) => {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  constructor() {
    super(...arguments);
    _ZodEnum_cache.set(this, void 0);
  }
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodEnum_cache, new Set(this._def.values), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f").has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
_ZodEnum_cache = /* @__PURE__ */ new WeakMap();
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  constructor() {
    super(...arguments);
    _ZodNativeEnum_cache.set(this, void 0);
  }
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodNativeEnum_cache, new Set(util.getValidEnumValues(this._def.values)), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f").has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
_ZodNativeEnum_cache = /* @__PURE__ */ new WeakMap();
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return base;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return base;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({ status: status.value, value: result }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function custom(check, params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      var _a, _b;
      if (!check(data)) {
        const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
        const _fatal = (_b = (_a = p.fatal) !== null && _a !== void 0 ? _a : fatal) !== null && _b !== void 0 ? _b : true;
        const p2 = typeof p === "string" ? { message: p } : p;
        ctx.addIssue({ code: "custom", ...p2, fatal: _fatal });
      }
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;
var z = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  defaultErrorMap: errorMap,
  setErrorMap,
  getErrorMap,
  makeIssue,
  EMPTY_PATH,
  addIssueToContext,
  ParseStatus,
  INVALID,
  DIRTY,
  OK,
  isAborted,
  isDirty,
  isValid,
  isAsync,
  get util() {
    return util;
  },
  get objectUtil() {
    return objectUtil;
  },
  ZodParsedType,
  getParsedType,
  ZodType,
  datetimeRegex,
  ZodString,
  ZodNumber,
  ZodBigInt,
  ZodBoolean,
  ZodDate,
  ZodSymbol,
  ZodUndefined,
  ZodNull,
  ZodAny,
  ZodUnknown,
  ZodNever,
  ZodVoid,
  ZodArray,
  ZodObject,
  ZodUnion,
  ZodDiscriminatedUnion,
  ZodIntersection,
  ZodTuple,
  ZodRecord,
  ZodMap,
  ZodSet,
  ZodFunction,
  ZodLazy,
  ZodLiteral,
  ZodEnum,
  ZodNativeEnum,
  ZodPromise,
  ZodEffects,
  ZodTransformer: ZodEffects,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodCatch,
  ZodNaN,
  BRAND,
  ZodBranded,
  ZodPipeline,
  ZodReadonly,
  custom,
  Schema: ZodType,
  ZodSchema: ZodType,
  late,
  get ZodFirstPartyTypeKind() {
    return ZodFirstPartyTypeKind;
  },
  coerce,
  any: anyType,
  array: arrayType,
  bigint: bigIntType,
  boolean: booleanType,
  date: dateType,
  discriminatedUnion: discriminatedUnionType,
  effect: effectsType,
  "enum": enumType,
  "function": functionType,
  "instanceof": instanceOfType,
  intersection: intersectionType,
  lazy: lazyType,
  literal: literalType,
  map: mapType,
  nan: nanType,
  nativeEnum: nativeEnumType,
  never: neverType,
  "null": nullType,
  nullable: nullableType,
  number: numberType,
  object: objectType,
  oboolean,
  onumber,
  optional: optionalType,
  ostring,
  pipeline: pipelineType,
  preprocess: preprocessType,
  promise: promiseType,
  record: recordType,
  set: setType,
  strictObject: strictObjectType,
  string: stringType,
  symbol: symbolType,
  transformer: effectsType,
  tuple: tupleType,
  "undefined": undefinedType,
  union: unionType,
  unknown: unknownType,
  "void": voidType,
  NEVER,
  ZodIssueCode,
  quotelessJson,
  ZodError
});

// ../../packages/contracts/src/clawbot.ts
var ClawBotStateSchema = z.enum([
  "unbound",
  "binding",
  "bound",
  "needs-interaction",
  "error"
]);
var ClawBotVerifyCodeSchema = z.object({
  code: z.string().trim().regex(/^\d{4,8}$/, "Verification code must contain 4-8 digits")
});
var ClawBotTestPushSchema = z.object({
  text: z.string().trim().min(1).max(4e3).optional()
});
var ClawBotChatProviderSchema = z.enum([
  "claude-sdk",
  "codex-sdk",
  "pi-sdk"
]);
var ClawBotChatSettingsInputSchema = z.object({
  enabled: z.boolean(),
  providerId: ClawBotChatProviderSchema,
  model: z.string().trim().min(1).max(200)
}).strict();
var ClawBotChatSettingsSchema = ClawBotChatSettingsInputSchema.extend({
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  queued: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable()
}).strict();

// ../../packages/contracts/src/scheduledTask.ts
var ScheduleKindSchema = z.enum(["one-time", "daily", "weekly"]);
var ScheduledTaskStatusSchema = z.enum([
  "idle",
  "running",
  "succeeded",
  "failed",
  "skipped"
]);
var ScheduledTaskPushStatusSchema = z.enum([
  "idle",
  "pending",
  "accepted",
  "failed",
  "needs-interaction",
  "skipped"
]);
var TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "timeOfDay must be HH:mm");
var ScheduledTaskCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  prompt: z.string().trim().min(1).max(2e5),
  scheduleKind: ScheduleKindSchema,
  timeOfDay: TimeOfDaySchema.nullish(),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  runAt: z.string().datetime({ offset: true }).nullish(),
  enabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(false)
}).superRefine((value, ctx) => {
  if (value.scheduleKind === "one-time" && !value.runAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runAt"], message: "runAt is required" });
  }
  if (value.scheduleKind !== "one-time" && !value.timeOfDay) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timeOfDay"], message: "timeOfDay is required" });
  }
  if (value.scheduleKind === "weekly" && value.weekdays.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "select at least one weekday" });
  }
});
var ScheduledTaskUpdateSchema = ScheduledTaskCreateSchema.and(z.object({ id: z.string().min(1) }));
var ScheduledTaskIdSchema = z.object({ id: z.string().min(1) });
var ScheduledTaskSetEnabledSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });

// ../../packages/contracts/src/sharedProvider.ts
var SharedProviderProtocolSchema = z.enum(["anthropic", "chat-completions", "responses"]);
var SharedProviderAgentSchema = z.enum(["claude", "codex", "pi"]);
var HttpUrlSchema = z.string().trim().max(2048).url().refine((value) => {
  const scheme = /^(https?):\/\//i.exec(value);
  if (!scheme || value.includes("?") || value.includes("#")) return false;
  const remainder = value.slice(scheme[0].length);
  const slash = remainder.indexOf("/");
  const authority = slash < 0 ? remainder : remainder.slice(0, slash);
  return authority.length > 0 && !authority.includes("@");
}, "must be an http(s) URL without embedded credentials, query, or fragment");
var SharedProviderModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256).optional(),
  /** Optional per-model interfaces. Missing means inherit provider protocols. */
  interfaces: z.array(SharedProviderProtocolSchema).min(1).max(3).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional()
}).strict();
function resolveSharedModelInterfaces(providerProtocols, modelInterfaces) {
  const source = modelInterfaces ?? providerProtocols;
  return source.filter((protocol) => providerProtocols.includes(protocol));
}
var EndpointOverridesSchema = z.object({
  anthropic: HttpUrlSchema.optional(),
  "chat-completions": HttpUrlSchema.optional(),
  responses: HttpUrlSchema.optional()
}).strict().optional();
function compatible(value) {
  return value.enabledAgents.every(
    (agent) => value.models.some((model) => {
      const protocols = new Set(resolveSharedModelInterfaces(value.protocols, model.interfaces));
      return agent === "claude" ? protocols.has("anthropic") || protocols.has("chat-completions") : agent === "codex" ? protocols.has("responses") : protocols.size > 0;
    })
  );
}
var SharedProviderCoreShape = {
  name: z.string().trim().min(1).max(256),
  baseUrl: HttpUrlSchema,
  modelsEndpoint: HttpUrlSchema.optional(),
  protocols: z.array(SharedProviderProtocolSchema).min(1).max(3),
  endpointOverrides: EndpointOverridesSchema,
  models: z.array(SharedProviderModelSchema).min(1).max(1e3),
  enabledAgents: z.array(SharedProviderAgentSchema).min(1).max(3)
};
function validateCore(value, ctx) {
  if (new Set(value.protocols).size !== value.protocols.length) ctx.addIssue({ code: "custom", message: "protocols must be unique" });
  if (new Set(value.enabledAgents).size !== value.enabledAgents.length) ctx.addIssue({ code: "custom", message: "enabledAgents must be unique" });
  if (new Set(value.models.map((model) => model.id)).size !== value.models.length) ctx.addIssue({ code: "custom", message: "model ids must be unique" });
  for (const model of value.models) {
    if (model.interfaces?.some((protocol) => !value.protocols.includes(protocol))) {
      ctx.addIssue({ code: "custom", message: `model interfaces must be enabled by provider: ${model.id}` });
    }
  }
  if (!compatible(value)) ctx.addIssue({ code: "custom", message: "enabled agent has no compatible protocol" });
  for (const protocol of Object.keys(value.endpointOverrides ?? {})) {
    if (!value.protocols.includes(protocol)) ctx.addIssue({ code: "custom", message: `endpoint override requires enabled protocol: ${protocol}` });
  }
}
var SharedProviderPublicSchema = z.object({
  ...SharedProviderCoreShape,
  id: z.string().uuid(),
  hasApiKey: z.boolean()
}).strict().superRefine(validateCore);
var SharedProviderSaveInputSchema = z.object({
  ...SharedProviderCoreShape,
  id: z.string().uuid().optional(),
  apiKey: z.string().max(65536).optional()
}).strict().superRefine(validateCore);
var SharedProviderRemoveInputSchema = z.object({ id: z.string().uuid() }).strict();
var SharedProviderDiscoverInputSchema = z.object({
  id: z.string().uuid().optional(),
  baseUrl: HttpUrlSchema,
  protocol: SharedProviderProtocolSchema,
  modelsEndpoint: HttpUrlSchema.optional(),
  apiKey: z.string().max(65536).optional()
}).strict();
var SharedProviderDiscoveredModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256)
}).strict();

// ../../packages/contracts/src/plugin.ts
var PLUGINS_ENABLED_SETTING_KEY = "plugins.enabled";
var PLUGINS_MCP_DISABLED_SETTING_KEY = "plugins.mcpDisabled";
var BUILTIN_MARKETPLACES = [
  { name: "zcode-plugins-official", url: "https://github.com/zai-org/zcode-plugins" },
  {
    name: "claude-plugins-official",
    url: "https://github.com/anthropics/claude-plugins-official"
  }
];
var PLUGIN_MANIFEST_DIRS = [".claude-plugin", ".zcode-plugin", ".codex-plugin"];
var PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
var PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /** Skills directory name(s) (default "skills"). */
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  /** Commands directory name(s) (default "commands"). */
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  /** Agents directory name(s) (default "agents"). */
  agents: z.union([z.string(), z.array(z.string())]).optional(),
  /** Hooks definition file(s), relative (default "hooks/hooks.json"). */
  hooks: z.union([z.string(), z.array(z.string())]).optional(),
  /** MCP servers definition file(s), relative (default ".mcp.json" at root). */
  mcpServers: z.union([z.string(), z.array(z.string())]).optional()
}).passthrough();
var PluginMarketEntrySourceSchema = z.union([
  z.string(),
  z.object({ source: z.literal("github"), repo: z.string().min(1) }).passthrough(),
  z.object({ source: z.literal("git"), url: z.string().min(1), ref: z.string().optional() }).passthrough(),
  z.object({
    source: z.literal("git-subdir"),
    url: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().optional(),
    /** Pinned commit; recorded but not enforced by v1 (the install-review
     *  dialog is the integrity gate). */
    sha: z.string().optional()
  }).passthrough(),
  z.object({ source: z.literal("url"), url: z.string().min(1) }).passthrough()
]);
var PluginMarketEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  source: PluginMarketEntrySourceSchema
}).passthrough();
var PluginMarketplaceManifestSchema = z.object({
  name: z.string().optional(),
  owner: z.string().optional(),
  plugins: z.array(PluginMarketEntrySchema)
}).passthrough();
var PluginsListSchema = z.object({});
var PluginsInstallLocalSchema = z.object({
  localPath: z.string().min(1)
});
var PluginsInstallGitSchema = z.object({
  url: z.string().min(1),
  ref: z.string().optional()
});
var PluginsInstallMarketplaceSchema = z.object({
  marketplace: z.string().min(1),
  name: z.string().min(1)
});
var PluginsSetEnabledSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  enabled: z.boolean()
});
var PluginsRemoveSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE)
});
var PluginsMarketplaceListSchema = z.object({});
var PluginsMarketplaceAddSchema = z.object({
  kind: z.enum(["git", "local"]),
  /** git URL, or absolute local directory path. */
  ref: z.string().min(1),
  name: z.string().regex(PLUGIN_NAME_RE).optional()
});
var PluginsMarketplaceRemoveSchema = z.object({
  name: z.string().min(1)
});
var PluginsMarketplaceRefreshSchema = z.object({
  name: z.string().min(1)
});

// ../../packages/contracts/src/relay.ts
var RELAY_DEFAULT_PUBLIC_PORT = 7331;
var RelayVpsConfigSchema = z.object({
  host: z.string().min(1).max(256),
  sshPort: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  password: z.string().max(256).default(""),
  privateKeyPath: z.string().max(512).optional(),
  publicPort: z.number().int().min(1).max(65535).default(RELAY_DEFAULT_PUBLIC_PORT),
  forwarder: z.enum(["auto", "socat", "python3"]).default("auto")
});

// ../../packages/contracts/src/ipc.ts
var ThemeNameSchema = z.enum(["dark", "light", "system"]);
var ThemeStyleSchema = z.enum(["classic", "sketch"]);
var DisplayModeSchema = z.enum(["single", "tabs"]);
var LeftBarModeSchema = z.enum(["tree", "stream"]);
var LocaleSchema = z.enum(["zh", "en"]);
var AutoArchiveConfigSchema = z.object({
  /** Master switch — when false, the AutoArchiver is a no-op. */
  enabled: z.boolean(),
  /** Global default inactivity threshold in days; applies to every project
   *  without an explicit override. */
  defaultDays: z.number().int().min(0),
  /** Per-project overrides: projectId -> threshold in days (`0` = never
   *  archive). Projects absent from this map inherit `defaultDays`. */
  overrides: z.record(z.string(), z.number().int().min(0))
});
var ChatDensitySchema = z.enum(["compact", "comfortable", "cozy"]);
var ProjectViewSchema = z.enum(["flat", "grouped"]);
var ProjectGroupMetaSchema = z.object({
  color: z.string().nullable().optional(),
  order: z.number().optional()
});
var ProjectGroupsMetaSchema = z.record(z.string(), ProjectGroupMetaSchema);
var AcceleratorSchema = z.object({
  key: z.string(),
  cmd: z.boolean().default(false),
  shift: z.boolean().default(false),
  alt: z.boolean().default(false)
});
var ShortcutBindingsSchema = z.record(z.string(), AcceleratorSchema);
var GestureDirectionSchema = z.enum([
  "L",
  "R",
  "U",
  "D",
  "UL",
  "UR",
  "DL",
  "DR"
]);
var GestureSequenceSchema = z.array(GestureDirectionSchema).min(1).max(8);
var GestureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  trigger: z.enum(["right", "middle"]).default("right"),
  overrides: z.record(z.string(), GestureSequenceSchema).default({})
});
var VoiceEngineSchema = z.enum(["zipformer", "parakeet"]);
var GetVoiceModelDirSchema = z.object({});
var GetVoiceModelDirResultSchema = z.object({
  /** The active root (never empty — resolves the default). */
  modelDir: z.string(),
  /** True when the user has customized the path. */
  isCustom: z.boolean()
});
var SetVoiceModelDirSchema = z.object({
  /** Absolute path, or "" to reset to the default. */
  modelDir: z.string()
});
var SetVoiceModelDirResultSchema = z.object({
  modelDir: z.string(),
  isCustom: z.boolean(),
  /** Catalog models found under the new root. */
  downloaded: z.array(z.string())
});
var RightPanelTabSchema = z.enum(["files", "git", "browser", "turns", "sidechat"]);
var TitleGenEnabledSchema = z.enum(["on", "off"]);
var NotificationPrefsSchema = z.object({
  osEnabled: z.boolean().default(true),
  turnComplete: z.boolean().default(true),
  errors: z.boolean().default(true),
  blocking: z.boolean().default(true),
  backgroundTasks: z.boolean().default(true)
});
var IdeEditorModeSchema = z.enum(["tabs", "replace"]);
var GitDiffOpenModeSchema = z.enum(["center", "dialog"]);
var PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto"
];
var PermissionModeSchema = z.enum(PERMISSION_MODES);
var StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  /** Provider id — which AI backend to use. Defaults to "claude-sdk". */
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().default("default"),
  permissionMode: z.string().default("default"),
  /** Id of a custom-model config to bind to this session (omit/null = built-in). */
  customModelId: z.string().nullable().optional(),
  /** Session role: "chat" (default, normal left-bar session) or "side"
   *  (side-chat Q&A session owned by the right-panel ask tab). Side sessions
   *  always create a fresh row — the createOrReuse fresh-row logic doesn't
   *  apply to them. */
  kind: z.enum(["chat", "side"]).default("chat"),
  /** For kind="side": the main session this Q&A thread belongs to. Enables
   *  traceability (one main session → many side chats). Ignored for chat. */
  parentSessionId: z.string().optional(),
  /** Working-environment intent for the new session. "worktree" records that
   *  the session's turns should run in an isolated checkout — the worktree
   *  itself is created when the FIRST turn is sent (intent-first,
   *  materialize-late), so unused sessions never leave empty worktrees
   *  behind. Only meaningful for kind="chat". */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM for envMode="worktree": "branch" materializes on a
   *  generated `mcode/*` branch (durable named commits — feature work),
   *  "detached" (default) keeps the classic detached checkout (experimental
   *  verification). Ignored for local sessions. */
  wtStyle: z.enum(["detached", "branch"]).optional(),
  /** BIND to an existing managed worktree directory instead of creating a
   *  fresh one: the new session shares the checkout (and its dependencies)
   *  of an already-materialized worktree session — "continue working in the
   *  same directory with a fresh thread". Must name a directory some OTHER
   *  session already references (main validates); ignored otherwise. Only
   *  meaningful together with envMode="worktree". */
  worktreePath: z.string().optional()
});
var ListSideChatsSchema = z.object({ parentSessionId: z.string() });
var SendTurnImageSchema = z.object({
  /** Base64-encoded image bytes (no data: prefix). */
  data: z.string().min(1).max(6e6),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"])
});
var SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
  /** User-attached images inlined into the provider request as base64 content
   *  blocks (NOT paths — the model server can't read the local filesystem).
   *  Sent alongside `prompt`; an image-only turn passes an empty prompt. */
  images: z.array(SendTurnImageSchema).max(20).optional(),
  /** Override session-scoped settings for this turn (reflects current UI state). */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  /** Override the session's bound custom model for this turn. null = clear
   *  (use built-in credential discovery); a string = bind to that config. */
  customModelId: z.string().nullable().optional(),
  /** Per-turn provider override. Normally the session's providerId is
   *  fixed at creation, but the UI can pass the active providerId here so
   *  the in-memory session is patched before RuntimeManager resolves the
   *  backend. Used as a per-turn override (NOT persisted — the session
   *  row's providerId stays as it was). */
  providerId: z.string().optional(),
  /** Skill names picked via composer skill pills this turn (no leading "/").
   *  Forwarded to the provider as the SDK `skills` allowlist so the model's
   *  Skill tool can reach them (stream-json input doesn't parse /name). */
  skills: z.array(z.string()).optional(),
  /** The sender's local user message (id / createdAt / display blocks).
   *  When present, the host echoes it to every client as a `user.message`
   *  RuntimeEvent so the prompt's bubble appears on the OTHER devices in
   *  real time (the sender dedupes by id — it already appended locally).
   *  Optional so older/foreign callers keep working (no echo, no dupes). */
  userMessage: z.object({
    id: z.string().min(1),
    createdAt: z.number(),
    blocks: z.array(z.unknown()),
    /** Set only when this send is an EDIT of an earlier user message
     *  (editAndResendMessage). Carries the id of the message being
     *  replaced so every OTHER client can truncate its own store at that
     *  message before appending the re-sent bubble — keeping their in-memory
     *  tail (and their turn.done persistence of it) consistent with the
     *  originator's truncation. Absent for a normal first send. */
    editedMessageId: z.string().optional()
  }).optional()
});
var InterruptSchema = z.object({ sessionId: z.string() });
var ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional()
});
var RespondQuestionSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  dismissed: z.boolean().optional()
});
var RespondPlanApprovalSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  editedPlan: z.string().optional(),
  reason: z.string().optional(),
  /* User's plan-adjustment feedback from the approval sheet. Attached to the
   * decision: on approve it's delivered to the model alongside the approval
   * (execution should incorporate it); on reject it doubles as the reason. */
  feedback: z.string().optional()
});
var RewindTurnSchema = z.object({
  sessionId: z.string(),
  files: z.array(
    z.object({
      filePath: z.string(),
      kind: z.enum(["modified", "created"]),
      adds: z.number(),
      dels: z.number(),
      before: z.string()
    })
  ),
  targetFiles: z.array(z.string())
});
var UpdateSessionSettingsSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  customModelId: z.string().nullable().optional(),
  /** Provider id (e.g. "claude-sdk"). Only honored while the session has no
   *  messages yet — once a turn has run the provider is fixed at creation, so
   *  the main handler rejects this field for non-empty sessions. */
  providerId: z.string().optional(),
  /** Working-environment intent flip (composer chip). Only meaningful while
   *  the session is un-materialized (no worktreePath yet) — the main-side
   *  updateSettings writes it, materialization later locks the environment. */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM flip (composer chip) — same un-materialized-only contract
   *  as envMode. null clears the intent back to the detached default (used
   *  when flipping the session to local so no stale intent lingers). */
  wtStyle: z.enum(["detached", "branch"]).nullable().optional(),
  /** Directory re-aim (new-session panel's directory switcher): move a FRESH
   *  local session to another project. The main handler honors it only while
   *  the session has no messages and no materialized worktree, and only onto
   *  an existing non-archived project — otherwise the whole call rejects and
   *  nothing changes. */
  projectId: z.string().optional()
});
var CreateProjectSchema = z.object({
  name: z.string(),
  path: z.string()
});
var DeleteProjectSchema = z.object({ id: z.string() });
var ArchiveProjectSchema = z.object({ id: z.string(), archived: z.boolean() });
var SetProjectGroupSchema = z.object({
  id: z.string(),
  group: z.string().max(50).nullable()
});
var ReorderProjectsSchema = z.object({
  orderedIds: z.array(z.string())
});
var PinProjectSchema = z.object({ id: z.string(), pinned: z.boolean() });
var RenameProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200)
});
var DeleteSessionSchema = z.object({ id: z.string() });
var ArchiveSessionSchema = z.object({ id: z.string(), archived: z.boolean() });
var PinSessionSchema = z.object({ id: z.string(), pinned: z.boolean() });
var SessionBookmarkSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  excerpt: z.string().max(400),
  // Optional (not just nullable) so bookmark lists persisted before the
  // rename feature existed parse unchanged.
  title: z.string().max(80).nullable().optional(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.number().int().nonnegative()
});
var UpdateBookmarksSchema = z.object({
  id: z.string(),
  bookmarks: z.array(SessionBookmarkSchema)
});
var RenameSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200)
});
var OpenPathSchema = z.object({ path: z.string() });
var ShowItemInFolderSchema = z.object({ path: z.string() });
var OpenFileSchema = z.object({ path: z.string() });
var ShowImageInFolderSchema = z.object({
  /** Full `data:image/<mime>;base64,...` URL of the displayed image. */
  dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(8e7)
});
var ShowImageInFolderResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute path of the revealed file (set when ok) — for logging, not display. */
  path: z.string().optional(),
  error: z.string().optional()
});
var ProjectSessionsSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  worktree: z.enum(["exclude", "only"]).optional()
});
var SessionListAllSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  /** Project scope: only rows whose project_id is in this list. A plain
   *  project scope sends one id, a group scope its member ids. Absent =
   *  all projects. */
  projectIds: z.array(z.string()).optional(),
  /** Worktree-checkout scope: only sessions bound to that isolated
   *  checkout, as a normalized path key (renderer's normWorktreeKey form —
   *  main compares with its normPathKey twin, since stored paths and
   *  porcelain output differ in separators/casing surface). */
  worktreeKey: z.string().optional()
});
var SessionSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional()
});
var BookmarkSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional()
});
var MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom((v2) => v2 !== void 0, "content is required"),
  createdAt: z.number()
});
var SessionMessagesSchema = z.object({
  sessionId: z.string(),
  /** Page size. Omit for the legacy unpaginated path (all rows). */
  limit: z.number().int().positive().optional(),
  /** Cursor: fetch the page strictly older than this (createdAt, id) pair.
   *  Omit on the first page (most recent). */
  beforeCreatedAt: z.number().optional(),
  beforeId: z.string().optional()
});
var SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema)
});
var UpsertMessagesSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageRecordSchema)
});
var TruncateAndInsertMessagesSchema = z.object({
  sessionId: z.string(),
  cursorCreatedAt: z.number(),
  cursorId: z.string(),
  messages: z.array(MessageRecordSchema)
});
var GetSettingSchema = z.object({ key: z.string() });
var SetSettingSchema = z.object({ key: z.string(), value: z.string() });
var GetManySettingsSchema = z.object({ keys: z.array(z.string()) });
var VoiceStartSchema = z.object({
  /** Opaque per-listen token chosen by the renderer (e.g. a random hex id). */
  sessionId: z.string().min(1),
  /** Speech language tag, e.g. "zh-CN" | "en-US". Picks the decoder language. */
  lang: z.string().min(1),
  /** Desired engine: "zipformer" (streaming, interim results) | "parakeet"
   *  (offline, higher accuracy). Falls back to zipformer when unavailable. */
  engine: VoiceEngineSchema
});
var VoiceFeedSchema = z.object({
  sessionId: z.string().min(1),
  pcm: z.union([z.instanceof(Float32Array), z.array(z.number()).max(65536 * 4)])
});
var VoiceStopSchema = z.object({ sessionId: z.string().min(1) });
var VoiceCancelSchema = z.object({ sessionId: z.string().min(1) });
var VoiceStopResultSchema = z.object({ text: z.string() });
var VoiceResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["partial", "final"]),
  text: z.string()
});
var VoiceDownloadModelSchema = z.object({
  modelId: z.string().min(1)
});
var VoiceModelListSchema = z.object({});
var VoiceModelListResultSchema = z.object({
  models: z.array(z.custom()),
  downloaded: z.array(z.string()),
  selected: z.string().nullable(),
  /** Active model root (after the user's customization, if any). */
  modelDir: z.string(),
  /** True when the user has set a custom model root. */
  isCustom: z.boolean()
});
var VoiceDownloadProgressPayloadSchema = z.object({
  modelId: z.string().min(1),
  stage: z.enum(["downloading", "done", "error", "cancelled"]),
  /** Whole-model progress 0–100 (includes file index weighting). */
  percent: z.number().min(0).max(100),
  /** 0-based index of the file currently downloading. */
  fileIndex: z.number().min(0),
  fileCount: z.number().min(1),
  /** Bytes so far for the current file (for small-file UIs). */
  fileBytes: z.number().min(0),
  /** Total bytes of the current file when known (Content-Length); lets the
   *  UI render "12.3 / 50.6 MB" instead of a bare percentage. */
  fileTotalBytes: z.number().min(0).optional(),
  error: z.string().optional()
});
var GetNotificationPrefsSchema = z.object({});
var FocusSessionSchema = z.object({ sessionId: z.string() });
var CustomModelEntrySchema = z.object({
  id: z.string().min(1),
  supports1m: z.boolean().optional()
});
var AuthModeSchema = z.enum(["auth_token", "api_key"]);
var ProtocolSchema = z.enum(["anthropic", "openai"]);
var CustomHeadersSchema = z.record(z.string(), z.string());
var SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  authToken: z.string().optional(),
  models: z.array(CustomModelEntrySchema).min(1),
  /** Task-subagent model pin (one of models[].id); the store drops a value
   *  not present in the list. Absent = follow the main session's model. */
  subagentModel: z.string().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  customHeaders: CustomHeadersSchema.optional()
});
var DeleteCustomModelSchema = z.object({ id: z.string() });
var TestCustomModelSchema = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  /** The single model id to probe in this request. */
  model: z.string().min(1),
  /** Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the
   *  model row's toggle. */
  supports1m: z.boolean().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  /** Headers to probe with, so an endpoint that requires one (and would
   *  otherwise fail the test) can be verified before saving. */
  customHeaders: CustomHeadersSchema.optional()
});
var GetCustomModelTokenSchema = z.object({ id: z.string().min(1) });
var SavePiProviderSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  apiKey: z.string().optional()
});
var DeletePiProviderSchema = z.object({ name: z.string().min(1) });
var GetPiApiKeySchema = z.object({ name: z.string().min(1) });
var SaveCodexProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      hint: z.string().optional(),
      /** Optional context-window override (spawned as `-c
       *  model_context_window=<n>`, process-local). */
      contextWindow: z.number().int().positive().optional()
    })
  ).min(1),
  /** Opt-in: unlock codex's image generation tool by injecting the
   *  `x-openai-actor-authorization` http_header into the provider's TOML
   *  table (gateway must back /v1/images/generations with gpt-image-2). */
  imageGeneration: z.boolean().optional(),
  apiKey: z.string().optional()
});
var DeleteCodexProviderSchema = z.object({ id: z.string().min(1) });
var GetCodexApiKeySchema = z.object({ id: z.string().min(1) });
var SetThemeSchema = z.object({ theme: ThemeNameSchema });
var FontsListSystemFamiliesSchema = z.object({
  /** Bypass the main-process cache — user just installed a font and reopened
   *  the picker. */
  refresh: z.boolean().optional()
});
var FileReadSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string()
});
var FileReadBinarySchema = z.object({
  /** Absolute path. Must resolve inside a known project root. */
  filePath: z.string()
});
var PickImagesSchema = z.object({});
var ClipboardSaveFileSchema = z.object({
  /** Original file name (display + extension preservation). */
  name: z.string().min(1).max(255),
  /** base64-encoded file bytes (~52MB file ceiling). */
  bytes: z.string().min(1).max(7e7)
});
var ClipboardSaveFileResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute temp path (set when ok). */
  path: z.string().optional(),
  error: z.string().optional()
});
var ClipboardWriteImageSchema = z.object({
  /** Full `data:image/<mime>;base64,...` URL of the image to copy. */
  dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(8e7)
});
var ClipboardWriteImageResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
});
var FileListDirSchema = z.object({
  /** Absolute path of the project root the listing is scoped to. Must match a
   *  persisted Project.path — main cross-checks this against ProjectRepo. */
  projectPath: z.string(),
  /** Directory to list, relative to projectPath. "" or "." = root. */
  dirPath: z.string()
});
var FileSearchSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Optional case-insensitive filter over file name / relative path. */
  query: z.string().optional(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; name search drops files outside the list. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max files to return. Defaults to 80 on the main side. */
  limit: z.number().int().positive().max(2e3).optional()
});
var FileWriteSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
  content: z.string()
});
var FileMkdirSchema = z.object({
  /** Absolute path of the directory to create. Must resolve inside a known
   *  project root (path-traversal guard, same as writeFile). */
  dirPath: z.string()
});
var FileDeleteSchema = z.object({
  /** Absolute path of the file or directory to trash. Must resolve inside a
   *  known project root (path-traversal guard, same as writeFile/mkdir). */
  targetPath: z.string()
});
var FileRenameSchema = z.object({
  /** Absolute path of the entry to rename. Must resolve inside a known project
   *  root. */
  oldPath: z.string(),
  /** Absolute path of the new name. Must be in the same project root and the
   *  same parent directory as `oldPath`. */
  newPath: z.string()
});
var FileCopySchema = z.object({
  /** Absolute path of the file to copy. Must resolve inside a known project
   *  root and be a regular file (not a directory). */
  srcPath: z.string(),
  /** Absolute path of the directory to copy into. Must resolve inside a known
   *  project root. */
  destDir: z.string(),
  /** Locale word used when deriving a clash-free name ("副本" / "copy").
   *  Defaults to "copy" when omitted. */
  suffix: z.string().optional()
});
var DialogPickFilesSchema = z.object({
  /** Optional dialog title; defaults to a localized "选择文件" on the main side. */
  title: z.string().optional()
});
var FileGrepSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Substring to search for inside file contents. */
  query: z.string(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; narrows rg's globs and the JS fallback. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max total matches to return. Defaults to 200 on the main side. */
  limit: z.number().int().positive().max(500).optional(),
  /** Max matches per single file. Defaults to 10 on the main side. */
  maxResultsPerFile: z.number().int().positive().max(50).optional(),
  /** Case-sensitive match. Defaults to false. */
  caseSensitive: z.boolean().optional()
});
var RgInstallSchema = z.object({});
var GitDiscoverReposSchema = z.object({
  projectPath: z.string(),
  rootOnly: z.boolean().optional()
});
var GitRepoPathSchema = z.object({
  repoPath: z.string()
});
var GitStageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string())
});
var GitUnstageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string())
});
var GitCommitSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1)
});
var GitDiffSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  /** If true, show staged (cached) diff — index vs HEAD. */
  staged: z.boolean().optional()
});
var GitFileBlobSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  side: z.enum(["index", "HEAD"])
});
var GitDiscardSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string())
});
var GitGenerateCommitSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
  /** The user's prompt template. The diff is appended after this. */
  prompt: z.string(),
  /** Optional cancellation key: when present, the AbortController driving the
   *  SDK query is registered under this id so git.cancelGenerateCommit can
   *  abort an in-flight generation. */
  requestId: z.string().optional(),
  /** Which diff feeds the generation: "staged" (default — index vs HEAD,
   *  the commit-box flow) or "worktree" (working tree vs HEAD, staged AND
   *  unstaged — the worktree merge-back flow, where agent changes are
   *  typically uncommitted). */
  scope: z.enum(["staged", "worktree"]).optional()
});
var GitCancelGenerateCommitSchema = z.object({
  requestId: z.string()
});
var GitLogSchema = z.object({
  repoPath: z.string(),
  /** Max commits to return (default 50, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Number of commits to skip (for pagination). */
  skip: z.number().int().min(0).optional(),
  /** Optional ref to start from (branch/tag/hash). Defaults to HEAD.
   *  Restricted to safe ref characters to avoid CLI injection. */
  ref: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref").optional()
});
var GitCommitHashSchema = z.string().regex(/^[0-9a-fA-F]{4,40}$/, "invalid commit hash");
var GitShowCommitSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema
});
var GitShowFileSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
  /** Path relative to the repo root (new path for renames). */
  filePath: z.string().min(1),
  /** Previous path when the file was renamed/copied in this commit. */
  oldPath: z.string().optional()
});
var GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** When provided, create this new local branch from `branch` and check it out. */
  newBranch: z.string().regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name").optional()
});
var GitDeleteBranchSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name"),
  /** Force delete (`git branch -D`) — skips the fully-merged safety check. */
  force: z.boolean().optional()
});
var GitMergeSchema = z.object({
  repoPath: z.string(),
  source: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref")
});
var GitWorktreeListSchema = z.object({
  /** The repo to list worktrees of. Any worktree of the repo works. */
  repoPath: z.string()
});
var GitWorktreeStatusSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string()
});
var GitWorktreeMergeBackSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Commit message for the pre-merge auto-commit of uncommitted worktree
   *  changes. Optional — blank/absent falls back to the built-in default
   *  ("worktree: auto-commit before merge back (<dir>)"). */
  message: z.string().optional()
});
var GitWorktreeRemoveSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Skip the uncommitted-changes check and pass --force. */
  force: z.boolean().optional(),
  /** Before removing, persist the worktree's FULL unmerged work (commits
   *  since the merge-base with the main HEAD, plus uncommitted edits) as a
   *  binary patch under userData/worktree-snapshots/ (last-resort recovery
   *  for discarded work). `patchPath` in the result tells the user where it
   *  went. */
  exportPatch: z.boolean().optional()
});
var SkillsListSchema = z.object({
  projectPath: z.string().optional()
});
var SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;
var SkillsReadSchema = z.object({
  /** Project root (must match a persisted Project.path). Only used to verify
   *  the caller's identity when source is "project"; the skill itself is
   *  resolved by `source` + `name`. */
  projectPath: z.string().optional(),
  /** Which skills root to read from: user-global or the active project. */
  source: z.enum(["global", "project"]),
  /** Skill name (= directory name under <root>/.claude/skills/). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name")
});
var SkillsSaveSchema = z.object({
  projectPath: z.string().optional(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
  /** Full SKILL.md text (frontmatter + body). Written verbatim. */
  content: z.string(),
  newName: z.string().regex(SKILL_NAME_RE).optional()
});
var SkillsDeleteSchema = z.object({
  projectPath: z.string().optional(),
  source: z.enum(["global", "project"]),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name")
});
var SkillsScanSourcesSchema = z.object({
  /** Optional: a user-picked local directory to scan in addition to the fixed
   *  external tool dirs. Used by the import dialog's "select folder" flow. */
  localDir: z.string().optional(),
  /** Optional: a user-picked single skill file (.md/.markdown) to import as a
   *  one-file skill. Used by the import dialog's "select file" flow. */
  localFile: z.string().optional()
});
var SkillsImportItemSchema = z.object({
  /** Absolute path to the source skill directory or file (from a scanSources
   *  result). */
  sourcePath: z.string(),
  /** Destination skill name (directory name under ~/.mcode/skills). */
  name: z.string().min(1)
});
var SkillsImportSchema = z.object({
  skills: z.array(SkillsImportItemSchema)
});
var SkillsSyncListSchema = z.object({});
var SkillsSyncAddSchema = z.object({
  sourceDir: z.string().min(1),
  label: z.string().min(1).max(80).optional()
});
var SkillsSyncSetEnabledSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
});
var SkillsSyncRemoveSchema = z.object({
  id: z.string().min(1)
});
var SkillsSyncRescanSchema = z.object({
  id: z.string().min(1).optional()
});
var MCP_SYNC_SOURCES_SETTING_KEY = "mcpSync.sources";
var McpSyncListSchema = z.object({});
var McpSyncScanSchema = z.object({});
var McpSyncAddSchema = z.object({
  file: z.string().min(1),
  kind: z.enum(["claude", "codex", "cursor", "zcode", "other"]).optional(),
  label: z.string().min(1).max(80).optional()
});
var McpSyncSetEnabledSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
});
var McpSyncRemoveSchema = z.object({
  id: z.string().min(1)
});
var McpSyncRescanSchema = z.object({
  id: z.string().min(1).optional()
});
var OutputStyleListSchema = z.object({});
var SYSTEM_PROMPT_MAX_CHARS = 2e4;
var SystemPromptReadProjectSchema = z.object({
  projectPath: z.string().min(1)
});
var SystemPromptWriteProjectSchema = z.object({
  projectPath: z.string().min(1),
  content: z.string().max(SYSTEM_PROMPT_MAX_CHARS)
});
var SystemPromptPreviewSchema = z.object({
  providerId: z.string().min(1),
  projectPath: z.string().min(1).nullable()
});
var MCP_MANAGEMENT_SETTING_KEY = "mcp.management";
var McpServerConfigSchema = z.union([
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional()
  }).passthrough(),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional()
  }).passthrough(),
  z.object({
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional()
  }).passthrough()
]);
var McpListSchema = z.object({
  projectPath: z.string().optional()
});
var McpToggleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["user", "project", "builtin", "plugin"]),
  projectPath: z.string().optional(),
  enabled: z.boolean()
});
var McpAuthorizeSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  kind: z.enum(["http", "sse"]),
  /** Source the clicked row came from. Scopes the main-side config lookup so a
   *  name shared by two sources (a user and a project server both called
   *  "github") resolves to the config that row actually points at — picking the
   *  other one's url/headers would file the token under a key the server never
   *  looks up. */
  scope: z.enum(["user", "project", "builtin", "plugin"]).optional(),
  /** Project whose .mcp.json the row came from (scope "project"). */
  projectPath: z.string().optional()
});
var McpUnauthorizeSchema = McpAuthorizeSchema;
var MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;
var MCP_RESERVED_NAME = "mcode-browser";
var McpSaveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema
});
var McpRemoveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name")
});
var McpScanImportSchema = z.object({});
var McpImportItemSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema
});
var McpImportSchema = z.object({
  servers: z.array(McpImportItemSchema)
});
var USAGE_STATS_PRESETS = ["today", "7d", "30d", "all"];
var UsageStatsSchema = z.object({
  preset: z.enum(USAGE_STATS_PRESETS)
});
var LspLanguageSchema = z.enum(["typescript", "python", "go", "java"]);
var LspListSchema = z.object({});
var LspInstallSchema = z.object({ language: LspLanguageSchema });
var LspInstallFromFileSchema = z.object({
  language: LspLanguageSchema,
  /** Absolute path to the user-selected file (archive or binary). */
  archivePath: z.string().min(1)
});
var LspUninstallSchema = z.object({ language: LspLanguageSchema });
var LspToggleSchema = z.object({
  language: LspLanguageSchema,
  enabled: z.boolean()
});
var LspSetPathSchema = z.object({
  language: LspLanguageSchema,
  serverPath: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Java only: override the JDK used to run jdtls (JAVA_HOME). */
  javaHome: z.string().optional()
});
var LspHealthCheckSchema = z.object({ language: LspLanguageSchema });
var LspPrewarmSchema = z.object({
  /** Project root to pre-warm (must be a known project). */
  workspacePath: z.string()
});
var LspRestartSchema = z.object({
  /** Project root the server was started for (must be a known project). */
  workspacePath: z.string(),
  language: LspLanguageSchema
});
var LspOpenDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  language: LspLanguageSchema
});
var LspCloseDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string()
});
var LspDidChangeSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
  version: z.number().int()
});
var LspDidSaveSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string()
});
var LspRequestSchema = z.object({
  workspacePath: z.string(),
  language: LspLanguageSchema,
  /** LSP method, e.g. "textDocument/definition". */
  method: z.string(),
  /** LSP params object (passed through verbatim). */
  params: z.unknown()
});
var RuntimeAgentSchema = z.enum(["claude", "codex", "pi"]);
var RuntimesListSchema = z.object({});
var RuntimesInstallSchema = z.object({ agent: RuntimeAgentSchema });
var RuntimesInstallLocalSchema = z.object({
  agent: RuntimeAgentSchema,
  /** Absolute local path (directory, binary, or .tgz). */
  localPath: z.string().min(1)
});
var RuntimesRemoveSchema = z.object({ agent: RuntimeAgentSchema });
var RuntimesSelectSchema = z.object({
  agent: RuntimeAgentSchema,
  mode: z.enum(["managed", "external"]),
  /** Required for external mode; discovery never binds a candidate implicitly. */
  path: z.string().optional(),
  /** Pi-only Node executable override. */
  nodePath: z.string().optional()
});
var RuntimesDiscoverSchema = z.object({ agent: RuntimeAgentSchema });
var TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1e3).optional(),
  rows: z.number().int().min(1).max(1e3).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional()
});
var TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string()
});
var TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1e3),
  rows: z.number().int().min(1).max(1e3)
});
var TerminalKillSchema = z.object({
  terminalId: z.string().min(1)
});
var TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional()
});
var BrowserCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional initial device-emulation preset applied once the view's renderer
   *  is ready (dom-ready). Used by the sidebar container to start in mobile
   *  mode without calling setDevice too early (which can crash the GPU
   *  process before it's initialized). Omit = desktop (no emulation). */
  initialDevice: z.enum([
    "desktop",
    "iphone",
    "iphone-se",
    "android",
    "galaxy-s23",
    "ipad-mini",
    "custom"
  ]).optional()
});
var BrowserLoadUrlSchema = z.object({
  browserId: z.string().min(1),
  url: z.string().min(1)
});
var BrowserGoBackSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserGoForwardSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserReloadSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserSetBoundsSchema = z.object({
  browserId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().int().min(1),
  height: z.number().int().min(1)
});
var BrowserSetPickModeSchema = z.object({
  browserId: z.string().min(1),
  enabled: z.boolean()
});
var BrowserShowSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserHideSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserCloseSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserBookmarkAddSchema = z.object({
  url: z.string().min(1),
  title: z.string()
});
var BrowserDownloadActionSchema = z.object({
  downloadId: z.string().min(1),
  action: z.enum(["open", "reveal"])
});
var BrowserBookmarkRemoveSchema = z.object({
  url: z.string().min(1)
});
var BrowserCaptureFrameSchema = z.object({
  browserId: z.string().min(1)
});
var BrowserSetDeviceSchema = z.object({
  browserId: z.string().min(1),
  device: z.enum([
    "desktop",
    "iphone",
    "iphone-se",
    "android",
    "galaxy-s23",
    "ipad-mini",
    "custom"
  ]),
  /** Custom viewport width (required when device === "custom"). */
  width: z.number().int().min(1).optional(),
  /** Custom viewport height (required when device === "custom"). */
  height: z.number().int().min(1).optional(),
  /** Screen orientation; "landscape" swaps width/height. Defaults to
   *  "portrait" when omitted (backward compatible with old callers). */
  orientation: z.enum(["portrait", "landscape"]).optional(),
  /** Effective emulated viewport size (CSS px) to apply. When set, overrides
   *  the preset/custom dims — used by the renderer to match the view's
   *  physical bounds exactly (e.g. a narrow sidebar column), which keeps
   *  capturePage() from returning black frames and pages from being clipped.
   *  Omit to use the preset/custom dims. */
  viewportWidth: z.number().int().min(1).optional(),
  viewportHeight: z.number().int().min(1).optional()
});
var BrowserHistoryRemoveSchema = z.object({
  url: z.string().min(1)
});
var BrowserHistoryClearSchema = z.object({});
var BrowserAuthRespondSchema = z.object({
  requestId: z.string().min(1),
  /** Empty username+password cancels the auth prompt. */
  username: z.string(),
  password: z.string()
});
var RevokeMobileDeviceSchema = z.object({ deviceId: z.string().min(1) });
var IPC = {
  // invoke/handle (RPC)
  CLAUDE_START_SESSION: "claude:startSession",
  CLAUDE_LIST_SIDE_CHATS: "claude:listSideChats",
  CLAUDE_SEND_TURN: "claude:sendTurn",
  CLAUDE_INTERRUPT: "claude:interrupt",
  CLAUDE_APPROVE: "claude:approve",
  CLAUDE_RESPOND_QUESTION: "claude:respondQuestion",
  CLAUDE_RESPOND_PLAN_APPROVAL: "claude:respondPlanApproval",
  CLAUDE_REWIND_TURN: "claude:rewindTurn",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_SESSIONS: "project:sessions",
  PROJECT_DELETE: "project:delete",
  PROJECT_ARCHIVE: "project:archive",
  PROJECT_SET_GROUP: "project:setGroup",
  PROJECT_REORDER: "project:reorder",
  PROJECT_PIN: "project:pin",
  PROJECT_RENAME: "project:rename",
  SESSION_DELETE: "session:delete",
  SESSION_ARCHIVE: "session:archive",
  SESSION_RENAME: "session:rename",
  SESSION_PIN: "session:pin",
  SESSION_UPDATE_BOOKMARKS: "session:updateBookmarks",
  SESSION_LIST_PINNED: "session:listPinned",
  SESSION_LIST_ALL: "session:listAll",
  SESSION_SEARCH: "session:search",
  SESSION_SEARCH_BOOKMARKS: "session:searchBookmarks",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPSERT_MESSAGES: "session:upsertMessages",
  SESSION_TRUNCATE_AND_INSERT_MESSAGES: "session:truncateAndInsertMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  // Settings
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  SETTING_GET_MANY: "setting:getMany",
  // Voice input
  VOICE_START: "voice:start",
  VOICE_FEED: "voice:feed",
  VOICE_STOP: "voice:stop",
  VOICE_CANCEL: "voice:cancel",
  /** Main → renderer push for live ASR results. */
  VOICE_RESULT: "voice:result",
  /** List catalog + downloaded models + active selection. */
  VOICE_MODEL_LIST: "voice:modelList",
  /** Begin downloading a catalog model. */
  VOICE_DOWNLOAD_MODEL: "voice:downloadModel",
  /** Cancel an in-flight model download. */
  VOICE_CANCEL_MODEL_DOWNLOAD: "voice:cancelModelDownload",
  /** Select a downloaded model as the active voice model. */
  VOICE_SELECT_MODEL: "voice:selectModel",
  /** Delete a downloaded model's local files. */
  VOICE_REMOVE_MODEL: "voice:removeModel",
  /** Read the current voice model root directory. */
  VOICE_GET_MODEL_DIR: "voice:getModelDir",
  /** Change the voice model root directory (or reset to default). */
  VOICE_SET_MODEL_DIR: "voice:setModelDir",
  /** Main → renderer push for model download progress. */
  VOICE_DOWNLOAD_PROGRESS: "voice:downloadProgress",
  // Notifications
  NOTIFICATION_GET_PREFS: "notification:getPrefs",
  NOTIFICATION_SET_PREFS: "notification:setPrefs",
  NOTIFICATION_FOCUS_SESSION: "notification:focusSession",
  // Custom models (user-defined Anthropic-compatible endpoints)
  CUSTOM_MODEL_LIST: "customModel:list",
  CUSTOM_MODEL_SAVE: "customModel:save",
  CUSTOM_MODEL_DELETE: "customModel:delete",
  CUSTOM_MODEL_TEST: "customModel:test",
  CUSTOM_MODEL_GET_TOKEN: "customModel:getToken",
  // Pi models (visual editor for ~/.pi/agent/models.json)
  PI_MODELS_LIST: "piModels:list",
  PI_MODELS_SAVE: "piModels:save",
  PI_MODELS_DELETE: "piModels:delete",
  PI_MODELS_GET_API_KEY: "piModels:getApiKey",
  PI_MODELS_LIST_AVAILABLE: "piModels:listAvailable",
  // Codex model providers (materialized into <CODEX_HOME>/config.toml)
  CODEX_MODELS_LIST: "codexModels:list",
  CODEX_MODELS_SAVE: "codexModels:save",
  CODEX_MODELS_DELETE: "codexModels:delete",
  CODEX_MODELS_GET_API_KEY: "codexModels:getApiKey",
  // Theme / color scheme
  THEME_GET: "theme:get",
  THEME_SET: "theme:set",
  // Fonts (UI font picker)
  FONTS_LIST_SYSTEM_FAMILIES: "fonts:listSystemFamilies",
  // File read (on-demand diff rendering)
  FILE_READ: "file:readFile",
  // File read as base64 data URL (image preview)
  FILE_READ_BINARY: "file:readBinary",
  // OS dialog image picker → base64 images (composer 图片 button)
  FILE_PICK_IMAGES: "file:pickImages",
  // Clipboard-pasted external file → temp path (composer paste)
  CLIPBOARD_SAVE_FILE: "clipboard:saveFile",
  // Image data URL → OS clipboard (image lightbox 复制)
  CLIPBOARD_WRITE_IMAGE: "clipboard:writeImage",
  // File tree listing + writing (P4 IDE right panel)
  FILE_LIST_DIR: "file:listDir",
  FILE_SEARCH: "file:search",
  FILE_WRITE: "file:writeFile",
  // Create a directory (file-tree "新建文件夹")
  FILE_MKDIR: "file:mkdir",
  // Delete a file or directory (file-tree "删除" — moves to system trash)
  FILE_DELETE: "file:delete",
  // Rename a file or directory in place (file-tree "重命名")
  FILE_RENAME: "file:rename",
  // Copy a file into a directory (file-tree "复制" + "粘贴" pair)
  FILE_COPY: "file:copy",
  FILE_GREP: "file:grep",
  RG_STATUS: "rg:status",
  RG_INSTALL: "rg:install",
  // Git operations (P4 Git panel)
  GIT_DISCOVER_REPOS: "git:discoverRepos",
  GIT_STATUS: "git:status",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_DIFF: "git:diff",
  GIT_FILE_BLOB: "git:fileBlob",
  GIT_DISCARD: "git:discard",
  GIT_GENERATE_COMMIT: "git:generateCommitMessage",
  GIT_CANCEL_GENERATE_COMMIT: "git:cancelGenerateCommitMessage",
  GIT_LOG: "git:log",
  GIT_SHOW_COMMIT: "git:showCommit",
  GIT_SHOW_FILE: "git:showFile",
  GIT_LIST_BRANCHES: "git:listBranches",
  GIT_CHECKOUT: "git:checkout",
  GIT_DELETE_BRANCH: "git:deleteBranch",
  GIT_MERGE_PREVIEW: "git:mergePreview",
  GIT_MERGE: "git:merge",
  GIT_MERGE_ABORT: "git:mergeAbort",
  // Git worktrees (isolated agent sessions)
  GIT_WORKTREE_LIST: "git:worktreeList",
  GIT_WORKTREE_STATUS: "git:worktreeStatus",
  GIT_WORKTREE_MERGE_BACK: "git:worktreeMergeBack",
  GIT_WORKTREE_REMOVE: "git:worktreeRemove",
  // Integrated terminal (P4 IDE right panel)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_LIST: "terminal:list",
  // Embedded browser (WebContentsView + DOM element picker)
  BROWSER_CREATE: "browser:create",
  BROWSER_LOAD_URL: "browser:loadUrl",
  BROWSER_GO_BACK: "browser:goBack",
  BROWSER_GO_FORWARD: "browser:goForward",
  BROWSER_RELOAD: "browser:reload",
  BROWSER_SET_BOUNDS: "browser:setBounds",
  BROWSER_SET_PICK_MODE: "browser:setPickMode",
  BROWSER_SHOW: "browser:show",
  BROWSER_HIDE: "browser:hide",
  BROWSER_CLOSE: "browser:close",
  BROWSER_CAPTURE_FRAME: "browser:captureFrame",
  BROWSER_BOOKMARK_ADD: "browser:bookmarkAdd",
  BROWSER_BOOKMARK_REMOVE: "browser:bookmarkRemove",
  BROWSER_SET_DEVICE: "browser:setDevice",
  BROWSER_CLEAR_CACHE: "browser:clearCache",
  // Clear sign-in state (cookies) of the embedded browser — separate from
  // clearCache, which deliberately keeps cookies so users stay signed in.
  BROWSER_CLEAR_COOKIES: "browser:clearCookies",
  // Address history + HTTP Basic Auth (embedded browser)
  BROWSER_HISTORY_REMOVE: "browser:historyRemove",
  BROWSER_HISTORY_CLEAR: "browser:historyClear",
  BROWSER_AUTH_RESPOND: "browser:authRespond",
  // Download bar (embedded browser): open file / reveal in folder
  BROWSER_DOWNLOAD_ACTION: "browser:downloadAction",
  // App / runtime info (About panel)
  APP_INFO: "app:info",
  // Auto-update (electron-updater)
  APP_CHECK_FOR_UPDATES: "app:checkForUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_QUIT_AND_INSTALL: "app:quitAndInstall",
  // Open a project root in the OS file manager (main refuses non-project paths)
  SHELL_OPEN_PATH: "shell:openPath",
  // Reveal a file/dir inside a project root in the OS file manager (selects it)
  SHELL_SHOW_ITEM_IN_FOLDER: "shell:showItemInFolder",
  // Open a file inside a project root with the OS default application
  SHELL_OPEN_FILE: "shell:openFile",
  // Reveal a chat image in the OS file manager (bytes in, resolved in main)
  SHELL_SHOW_IMAGE_IN_FOLDER: "shell:showImageInFolder",
  // Native multi-file picker (project-external files allowed) for the composer
  DIALOG_PICK_FILES: "dialog:pickFiles",
  // Skill discovery for the composer `/` menu (scans ~/.claude/skills + project)
  SKILLS_LIST: "skills:list",
  // Skill management (settings panel): read / save / delete a single skill
  SKILLS_READ: "skills:read",
  SKILLS_SAVE: "skills:save",
  SKILLS_DELETE: "skills:delete",
  // Skill import (settings panel): scan external tools + copy into ~/.mcode/skills
  SKILLS_SCAN_SOURCES: "skills:scanSources",
  SKILLS_IMPORT: "skills:import",
  // External skill sync (settings panel): attach external skill directories as
  // watched sources mirrored into ~/.mcode/skills-sync (TODO-004)
  SKILLS_SYNC_LIST: "skills:syncList",
  SKILLS_SYNC_ADD: "skills:syncAdd",
  SKILLS_SYNC_SET_ENABLED: "skills:syncSetEnabled",
  SKILLS_SYNC_REMOVE: "skills:syncRemove",
  SKILLS_SYNC_RESCAN: "skills:syncRescan",
  SKILLS_SYNC_CHANGED: "skills:syncChanged",
  // MCP management (settings panel): list / toggle / add / remove / import
  MCP_LIST: "mcp:list",
  MCP_TOGGLE: "mcp:toggle",
  MCP_AUTHORIZE: "mcp:authorize",
  MCP_UNAUTHORIZE: "mcp:unauthorize",
  MCP_SAVE: "mcp:save",
  MCP_REMOVE: "mcp:remove",
  MCP_SCAN_IMPORT: "mcp:scanImport",
  MCP_IMPORT: "mcp:import",
  // External MCP config sync (settings panel): watch external tool config
  // files and mirror their servers into ~/.mcode/.claude.json (TODO-004)
  MCP_SYNC_LIST: "mcp:syncList",
  MCP_SYNC_SCAN: "mcp:syncScan",
  MCP_SYNC_ADD: "mcp:syncAdd",
  MCP_SYNC_SET_ENABLED: "mcp:syncSetEnabled",
  MCP_SYNC_REMOVE: "mcp:syncRemove",
  MCP_SYNC_RESCAN: "mcp:syncRescan",
  MCP_SYNC_CHANGED: "mcp:syncChanged",
  // Output styles (settings panel): list built-in + user styles
  OUTPUT_STYLE_LIST: "outputStyle:list",
  // Unified system prompt (settings panel): project file + layered preview
  SYSTEM_PROMPT_READ_PROJECT: "systemPrompt:readProject",
  SYSTEM_PROMPT_WRITE_PROJECT: "systemPrompt:writeProject",
  SYSTEM_PROMPT_PREVIEW: "systemPrompt:preview",
  // Usage stats (settings panel): aggregated token/cost usage over time ranges
  USAGE_STATS: "usage:stats",
  // Language servers (LSP): install/enable/sync/request
  LSP_LIST: "lsp:list",
  LSP_INSTALL: "lsp:install",
  LSP_INSTALL_FROM_FILE: "lsp:installFromFile",
  LSP_UNINSTALL: "lsp:uninstall",
  LSP_TOGGLE: "lsp:toggle",
  LSP_SET_PATH: "lsp:setPath",
  LSP_HEALTH_CHECK: "lsp:healthCheck",
  LSP_PREWARM: "lsp:prewarm",
  LSP_RESTART: "lsp:restart",
  LSP_OPEN_DOC: "lsp:openDocument",
  LSP_CLOSE_DOC: "lsp:closeDocument",
  LSP_DID_CHANGE: "lsp:didChange",
  LSP_DID_SAVE: "lsp:didSave",
  LSP_REQUEST: "lsp:request",
  // Agent runtimes (download-on-demand): list/install/remove + progress push
  RUNTIMES_LIST: "runtimes:list",
  RUNTIMES_INSTALL: "runtimes:install",
  RUNTIMES_INSTALL_LOCAL: "runtimes:installLocal",
  RUNTIMES_REMOVE: "runtimes:remove",
  RUNTIMES_SELECT: "runtimes:select",
  RUNTIMES_DISCOVER: "runtimes:discover",
  RUNTIMES_EVENT: "runtimes:event",
  SHARED_PROVIDERS_LIST: "sharedProviders:list",
  SHARED_PROVIDERS_SAVE: "sharedProviders:save",
  SHARED_PROVIDERS_REMOVE: "sharedProviders:remove",
  SHARED_PROVIDERS_DISCOVER_MODELS: "sharedProviders:discoverModels",
  SCHEDULER_LIST: "scheduler:list",
  SCHEDULER_CREATE: "scheduler:create",
  SCHEDULER_UPDATE: "scheduler:update",
  SCHEDULER_DELETE: "scheduler:delete",
  SCHEDULER_RUN_NOW: "scheduler:runNow",
  SCHEDULER_SET_ENABLED: "scheduler:setEnabled",
  CLAWBOT_STATUS: "clawbot:status",
  CLAWBOT_START_BINDING: "clawbot:startBinding",
  CLAWBOT_POLL_BINDING: "clawbot:pollBinding",
  CLAWBOT_SUBMIT_VERIFY_CODE: "clawbot:submitVerifyCode",
  CLAWBOT_CANCEL_BINDING: "clawbot:cancelBinding",
  CLAWBOT_UNBIND: "clawbot:unbind",
  CLAWBOT_TEST_PUSH: "clawbot:testPush",
  CLAWBOT_GET_CHAT_SETTINGS: "clawbot:getChatSettings",
  CLAWBOT_UPDATE_CHAT_SETTINGS: "clawbot:updateChatSettings",
  CLAWBOT_RESUME_CHAT: "clawbot:resumeChat",
  // Plugins (settings panel): list/install (local/git/marketplace)/enable/
  // remove + marketplace management. No push channel — every RPC resolves
  // when done and the panel re-lists.
  PLUGINS_LIST: "plugins:list",
  PLUGINS_INSTALL_LOCAL: "plugins:installLocal",
  PLUGINS_INSTALL_GIT: "plugins:installGit",
  PLUGINS_INSTALL_MARKETPLACE: "plugins:installMarketplace",
  PLUGINS_SET_ENABLED: "plugins:setEnabled",
  PLUGINS_REMOVE: "plugins:remove",
  PLUGINS_MARKETPLACE_LIST: "plugins:marketplaceList",
  PLUGINS_MARKETPLACE_ADD: "plugins:marketplaceAdd",
  PLUGINS_MARKETPLACE_REMOVE: "plugins:marketplaceRemove",
  PLUGINS_MARKETPLACE_REFRESH: "plugins:marketplaceRefresh",
  // Mobile companion (LAN pairing + device management) — invoke/handle (RPC).
  MOBILE_START_PAIRING: "mobile:startPairing",
  MOBILE_GET_PAIRING: "mobile:getPairing",
  MOBILE_CANCEL_PAIRING: "mobile:cancelPairing",
  MOBILE_LIST_DEVICES: "mobile:listDevices",
  MOBILE_REVOKE_DEVICE: "mobile:revokeDevice",
  MOBILE_GET_STATUS: "mobile:getStatus",
  MOBILE_GET_ACTIVE_COUNT: "mobile:getActiveCount",
  // Relay (SSH-based remote access) — invoke/handle (RPC).
  RELAY_SAVE_CONFIG: "relay:saveConfig",
  RELAY_GET_CONFIG: "relay:getConfig",
  RELAY_CONNECT: "relay:connect",
  RELAY_DISCONNECT: "relay:disconnect",
  RELAY_STATUS: "relay:status",
  // Relay push events (main → renderer).
  RELAY_EVENT: "relay:event",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  SESSION_TITLE_UPDATED: "session:titleUpdated",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  LSP_EVENT: "lsp:event",
  BROWSER_EVENT: "browser:event",
  THEME_CHANGED: "theme:changed",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:downloadProgress",
  UPDATE_DOWNLOADED: "update:downloaded",
  WINDOW_FOCUS_CHANGED: "window:focusChanged"
};

// src/main/window.ts
import { BrowserWindow, shell, session } from "electron";

// src/main/lib/theme.ts
import { nativeTheme } from "electron";

// src/main/store/repositories.ts
function v(x) {
  if (x === void 0 || x === null) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  return x;
}
function run(sql, ...params) {
  getDb().prepare(sql).run(...params);
}
function rowToProject(r) {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    archived: !!r.archived,
    // Normalize empty string / undefined (pre-migration rows) to null so the
    // renderer only ever sees null | <non-empty group name>.
    group: r.group && r.group.length > 0 ? r.group : null,
    sortOrder: r.sort_order ?? 0,
    pinnedAt: r.pinned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
var rootPathsCache = null;
var ProjectRepo = {
  create(p) {
    const db2 = getDb();
    const nextOrder = db2.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects").get().next;
    run(
      "INSERT INTO projects (id, name, path, archived, `group`, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      v(p.id),
      v(p.name),
      v(p.path),
      v(p.archived ? 1 : 0),
      v(p.group ?? null),
      v(nextOrder),
      v(p.createdAt),
      v(p.updatedAt)
    );
    persist();
    rootPathsCache = null;
  },
  list() {
    const rows = getDb().prepare("SELECT * FROM projects ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, sort_order ASC, created_at ASC").all();
    return rows.map(rowToProject);
  },
  /** Root paths of all persisted projects, served from an in-memory cache.
   *  Use in guard checks that only need the path set (known-root match /
   *  containment) instead of {@link list} — the file tree calls these on
   *  every expand. Callers needing other fields (archived, group, …) must
   *  use {@link list}; mutations re-populate the cache lazily. */
  listPaths() {
    if (!rootPathsCache) rootPathsCache = ProjectRepo.list().map((p) => p.path);
    return rootPathsCache;
  },
  get(id) {
    const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(v(id));
    return row ? rowToProject(row) : void 0;
  },
  /** Hard-delete a project. Child sessions + messages cascade-delete via the
   *  sessions.project_id / messages.session_id ON DELETE CASCADE constraints
   *  (PRAGMA foreign_keys = ON is set in initDb). */
  delete(id) {
    run("DELETE FROM projects WHERE id = ?", v(id));
    persist();
    rootPathsCache = null;
  },
  /** Set the archived (soft-delete) flag. */
  setArchived(id, archived) {
    run(
      "UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?",
      v(archived ? 1 : 0),
      v(Date.now()),
      v(id)
    );
    persist();
    rootPathsCache = null;
  },
  /** Assign a project to a group. Pass null to remove it from any group.
   *  `group` is a column name in SQLite so it must be backtick-quoted. */
  setGroup(id, group) {
    run(
      "UPDATE projects SET `group` = ?, updated_at = ? WHERE id = ?",
      v(group ?? null),
      v(Date.now()),
      v(id)
    );
    persist();
    rootPathsCache = null;
  },
  /** Rename a project (display-only; the path is never touched). */
  rename(id, name) {
    run(
      "UPDATE projects SET name = ?, updated_at = ? WHERE id = ?",
      v(name),
      v(Date.now()),
      v(id)
    );
    persist();
    rootPathsCache = null;
  },
  /** Pin/unpin a project: pinned rows write the current timestamp (most
   *  recent pin sorts first), unpinned rows write NULL. Mirrors
   *  SessionRepo.setPinned — sort_order is left alone so unpinning returns
   *  the project to its drag-order position, and `updated_at` is not bumped
   *  (pinning is metadata, not activity). */
  setPinned(id, pinned) {
    run(
      "UPDATE projects SET pinned_at = ? WHERE id = ?",
      v(pinned ? Date.now() : null),
      v(id)
    );
    persist();
    rootPathsCache = null;
  },
  /** Rewrite sort_order for every id in `orderedIds` (index = position).
   *  Accepts the full ordered list so the operation is idempotent and
   *  self-healing — gaps from prior deletes collapse on the next reorder.
   *  Unknown ids in the input are skipped (the UPDATE matches nothing); ids
   *  absent from the input keep their old sort_order. Mirrors the
   *  MessageRepo.replaceAll transaction pattern. */
  reorder(orderedIds) {
    const db2 = getDb();
    const stmt = db2.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
    db2.exec("BEGIN");
    try {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(v(i), v(orderedIds[i]));
      }
      db2.exec("COMMIT");
    } catch (err) {
      db2.exec("ROLLBACK");
      throw err;
    }
    persist();
    rootPathsCache = null;
  }
};
var SettingRepo = {
  get(key) {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(v(key));
    return row ? String(row.value) : null;
  },
  /** Read multiple keys in one pass. The driver is synchronous so this is a
   *  single tick — cheaper for the renderer than N parallel `setting.get`
   *  round-trips (one IPC instead of N). Missing keys map to `null`. */
  getMany(keys) {
    const db2 = getDb();
    const out = {};
    const stmt = db2.prepare("SELECT value FROM settings WHERE key = ?");
    for (const k of keys) {
      const row = stmt.get(v(k));
      out[k] = row ? String(row.value) : null;
    }
    return out;
  },
  /** Upsert a setting value. */
  set(key, value) {
    run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      v(key),
      v(value)
    );
    persist();
  }
};

// src/main/lib/startupTimer.ts
var bootMs = performance.now();

// src/main/window.ts
var mainWindow = null;
function sendToRenderer(channel, ...args) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed()) return;
  wc.send(channel, ...args);
}

// src/main/terminal/shellResolve.ts
import { existsSync as existsSync3 } from "node:fs";

// src/main/lib/binaryResolve.ts
import { existsSync as existsSync2 } from "node:fs";
import { delimiter, dirname, join as join3 } from "node:path";
import { execFileSync } from "node:child_process";
function which(name) {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync2(name) ? name : null;
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where.exe", [name], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
      if (out && existsSync2(out)) return out;
    } catch {
    }
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    const appdata = process.env["APPDATA"] ?? "";
    const candidates = [
      join3(pf, "PowerShell", "7", `${name}.exe`),
      join3(pf, "PowerShell", "7-preview", `${name}.exe`),
      join3(local, "Microsoft", "WindowsApps", `${name}.exe`),
      join3(pf, "Git", "bin", `${name}.exe`),
      join3(pf, "Git", "usr", "bin", `${name}.exe`),
      join3(pf86, "Git", "bin", `${name}.exe`),
      // npm global bin (where language servers like typescript-language-server
      // get installed by `npm i -g`).
      join3(appdata, "npm", `${name}.cmd`),
      join3(appdata, "npm", `${name}`),
      join3(process.env["SystemRoot"] ?? "C:\\Windows", "System32", `${name}.exe`),
      join3(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", `${name}.exe`)
    ];
    for (const c of candidates) {
      if (existsSync2(c)) return c;
    }
    return null;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join3(dir, name);
    if (existsSync2(full)) return full;
  }
  for (const full of [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync2(full)) return full;
  }
  return null;
}

// src/main/terminal/shellResolve.ts
function winShellFromPath(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith("pwsh.exe") || lower.endsWith("\\pwsh") || lower.endsWith("/pwsh")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.includes("powershell")) {
    return { file, args: ["-NoLogo"], label: file };
  }
  if (lower.endsWith("bash.exe") || lower.endsWith("\\bash") || lower.endsWith("/bash")) {
    return { file, args: ["--login", "-i"], label: file };
  }
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd") || lower.endsWith("/cmd")) {
    return { file, args: [], label: file };
  }
  return { file, args: [], label: file };
}
function posixShellFromPath(file) {
  const base = file.split("/").pop() ?? file;
  if (base === "bash" || base === "zsh") {
    return { file, args: ["-l"], label: file };
  }
  return { file, args: [], label: file };
}
function resolveOverride(override) {
  const trimmed = override.trim();
  if (!trimmed) return null;
  const found = which(trimmed) ?? (existsSync3(trimmed) ? trimmed : null);
  if (!found) {
    log.warn(`terminal.shell override not found: ${trimmed}`);
    return null;
  }
  return process.platform === "win32" ? winShellFromPath(found) : posixShellFromPath(found);
}
function resolveDefaultShell(override) {
  if (override) {
    const o = resolveOverride(override);
    if (o) return o;
  }
  if (process.platform === "win32") {
    const order = [
      { name: "pwsh", args: ["-NoLogo"] },
      { name: "powershell", args: ["-NoLogo"] },
      { name: "bash", args: ["--login", "-i"] },
      { name: "cmd", args: [] }
    ];
    for (const cand of order) {
      const file = which(cand.name);
      if (file) return { file, args: cand.args, label: file };
    }
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: [], label: comspec };
  }
  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    const found = which(shellEnv) ?? (existsSync3(shellEnv) ? shellEnv : null);
    if (found) return posixShellFromPath(found);
  }
  for (const name of ["bash", "zsh", "sh"]) {
    const file = which(name);
    if (file) return posixShellFromPath(file);
  }
  return { file: "/bin/sh", args: [], label: "/bin/sh" };
}

// src/main/terminal/envRefresh.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { join as join4 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var REGISTRY_DUMP_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$tab = [char]9",
  "foreach ($kp in @('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU:\\Environment')) {",
  "  $scope = 'U'",
  "  if ($kp -like 'HKLM:*') { $scope = 'S' }",
  "  $k = Get-Item -LiteralPath $kp -ErrorAction SilentlyContinue",
  "  if ($null -eq $k) { continue }",
  "  foreach ($n in $k.GetValueNames()) {",
  "    if ([string]::IsNullOrEmpty($n)) { continue }",
  "    $kind = $k.GetValueKind($n).ToString()",
  "    if ($kind -ne 'String' -and $kind -ne 'ExpandString') { continue }",
  "    $raw = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "    if ($null -eq $raw) { continue }",
  "    $kc = 'S'",
  "    if ($kind -eq 'ExpandString') { $kc = 'E' }",
  "    Write-Output (@($scope, $kc, $n, [string]$raw) -join $tab)",
  "  }",
  "}"
].join("\n");
var PS_TIMEOUT_MS = 8e3;
var PS_MAX_BUFFER = 4 * 1024 * 1024;
var REGISTRY_ENV_TTL_MS = 1e4;
var registryEnvPromise = null;
var registryEnvFetchedAt = 0;
function resolvePowerShellExe() {
  const sysRoot = process.env.SystemRoot ?? process.env.systemroot ?? "C:\\Windows";
  const candidate = join4(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync4(candidate) ? candidate : "powershell.exe";
}
async function readRegistryEnv() {
  try {
    const { stdout } = await execFileAsync(
      resolvePowerShellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", REGISTRY_DUMP_SCRIPT],
      { windowsHide: true, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: "utf8" }
    );
    const system = /* @__PURE__ */ new Map();
    const user = /* @__PURE__ */ new Map();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      const parts = line.split("	");
      if (parts.length < 4) continue;
      const [scope, kind, name, ...valueParts] = parts;
      if (!name) continue;
      if (scope !== "S" && scope !== "U" || kind !== "S" && kind !== "E") continue;
      const entry = { name, value: valueParts.join("	"), expand: kind === "E" };
      (scope === "S" ? system : user).set(name.toUpperCase(), entry);
    }
    if (system.size === 0 && user.size === 0) return null;
    return { system, user };
  } catch {
    return null;
  }
}
function getRegistryEnvCached() {
  if (registryEnvPromise && Date.now() - registryEnvFetchedAt < REGISTRY_ENV_TTL_MS) {
    return registryEnvPromise;
  }
  registryEnvFetchedAt = Date.now();
  const p = readRegistryEnv().then(
    (r) => {
      if (!r && registryEnvPromise === p) {
        registryEnvPromise = null;
        registryEnvFetchedAt = 0;
      }
      return r;
    },
    () => null
  );
  registryEnvPromise = p;
  return p;
}
function splitPathEntries(path8) {
  return path8.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}
function pathEntryKey(entry) {
  return entry.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
async function buildTerminalEnv() {
  const env = {};
  for (const [k, v2] of Object.entries(process.env)) {
    if (typeof v2 === "string") env[k] = v2;
  }
  if (process.platform !== "win32") {
    return { env, registryVarsApplied: null };
  }
  const reg = await getRegistryEnvCached();
  if (!reg) {
    return { env, registryVarsApplied: null };
  }
  const lookup = /* @__PURE__ */ new Map();
  for (const [k, v2] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (!lookup.has(upper)) lookup.set(upper, v2);
  }
  for (const rv of reg.system.values()) lookup.set(rv.name.toUpperCase(), rv.value);
  for (const rv of reg.user.values()) lookup.set(rv.name.toUpperCase(), rv.value);
  const expand = (v2) => v2.replace(/%([^%]+)%/g, (ref, name) => lookup.get(name.toUpperCase()) ?? ref);
  const existingKeys = /* @__PURE__ */ new Map();
  for (const k of Object.keys(env)) {
    const upper = k.toUpperCase();
    if (!existingKeys.has(upper)) existingKeys.set(upper, k);
  }
  let applied = 0;
  const overlay = (rv, value) => {
    const upper = rv.name.toUpperCase();
    const existing = existingKeys.get(upper);
    if (existing !== void 0 && existing !== rv.name) delete env[existing];
    env[rv.name] = value;
    existingKeys.set(upper, rv.name);
    applied++;
  };
  const sysPath = reg.system.get("PATH");
  const usrPath = reg.user.get("PATH");
  if (sysPath !== void 0 || usrPath !== void 0) {
    const mergedEntries = [];
    const seen = /* @__PURE__ */ new Set();
    const pushEntry = (entry) => {
      const key = pathEntryKey(entry);
      if (!seen.has(key)) {
        mergedEntries.push(entry);
        seen.add(key);
      }
    };
    for (const scope of [sysPath, usrPath]) {
      if (!scope) continue;
      for (const entry of splitPathEntries(expand(scope.value))) pushEntry(entry);
    }
    const inherited = env[existingKeys.get("PATH") ?? "PATH"] ?? "";
    for (const entry of splitPathEntries(inherited)) pushEntry(entry);
    const pathName = sysPath?.name ?? usrPath?.name ?? "Path";
    const existing = existingKeys.get("PATH");
    if (existing !== void 0 && existing !== pathName) delete env[existing];
    env[pathName] = mergedEntries.join(";");
    existingKeys.set("PATH", pathName);
    applied++;
  }
  for (const rv of reg.system.values()) {
    if (rv.name.toUpperCase() === "PATH") continue;
    overlay(rv, rv.expand ? expand(rv.value) : rv.value);
  }
  for (const rv of reg.user.values()) {
    if (rv.name.toUpperCase() === "PATH") continue;
    overlay(rv, rv.expand ? expand(rv.value) : rv.value);
  }
  return { env, registryVarsApplied: applied };
}

// src/main/terminal/TerminalManager.ts
var require2 = createRequire(import.meta.url);
function loadNodePty() {
  const mod = require2("node-pty");
  ensureSpawnHelperExecutable();
  return mod;
}
function ensureSpawnHelperExecutable() {
  if (process.platform === "win32") return;
  try {
    const ptyRoot = require2.resolve("node-pty/lib/unixTerminal.js");
    const libDir = dirname2(ptyRoot);
    const platArch = `${process.platform}-${process.arch}`;
    const candidates = [
      join5(libDir, "..", "build", "Release"),
      join5(libDir, "..", "build", "Debug"),
      join5(libDir, "..", "prebuilds", platArch)
    ];
    for (const dir of candidates) {
      const helper = join5(dir, "spawn-helper");
      if (!existsSync5(helper)) continue;
      try {
        if (!(statSync(helper).mode & 73)) {
          chmodSync(helper, 493);
          log.info(`spawn-helper chmod +x: ${helper}`);
        }
      } catch (e) {
        log.warn(`spawn-helper chmod failed (${helper}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
  } catch {
  }
}
var TerminalManagerImpl = class {
  terminals = /* @__PURE__ */ new Map();
  /**
   * Async because the env build refreshes the live Windows registry environment
   * (see envRefresh.ts) before spawning — a fresh system-terminal-equivalent
   * env costs one short-lived powershell.exe run (~hundreds of ms cold).
   */
  async create(opts) {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const resolved = resolveDefaultShell(opts.shell ?? opts.shellSetting ?? null);
    let ptyMod;
    try {
      ptyMod = loadNodePty();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`node-pty failed to load: ${msg}`);
      return {
        ok: false,
        error: `\u65E0\u6CD5\u52A0\u8F7D\u7EC8\u7AEF\u539F\u751F\u6A21\u5757 (node-pty): ${msg}`
      };
    }
    const { env, registryVarsApplied } = await buildTerminalEnv();
    if (process.platform === "win32") {
      if (registryVarsApplied === null) {
        log.warn("terminal env: registry refresh failed, using inherited process env");
      } else {
        log.info(`terminal env: refreshed ${registryVarsApplied} vars from live registry`);
      }
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = env.COLORTERM ?? "truecolor";
    env.LANG = env.LANG ?? "en_US.UTF-8";
    const id = randomUUID();
    let pty;
    try {
      pty = ptyMod.spawn(resolved.file, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: opts.cwd,
        env,
        useConptyDll: process.platform === "win32"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`terminal spawn failed: ${resolved.file} ${msg}`);
      return { ok: false, error: `\u542F\u52A8 shell \u5931\u8D25 (${resolved.label}): ${msg}` };
    }
    const info = {
      terminalId: id,
      cwd: opts.cwd,
      shell: resolved.label,
      pid: pty.pid,
      projectPath: opts.projectPath
    };
    const live = { id, pty, info };
    this.terminals.set(id, live);
    pty.onData((data) => {
      if (!this.terminals.has(id)) return;
      sendToRenderer(IPC.TERMINAL_DATA, {
        channel: IPC.TERMINAL_DATA,
        terminalId: id,
        data
      });
    });
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      sendToRenderer(IPC.TERMINAL_EXIT, {
        channel: IPC.TERMINAL_EXIT,
        terminalId: id,
        exitCode: typeof exitCode === "number" ? exitCode : null
      });
      log.info(`terminal exited: ${id} code=${exitCode}`);
    });
    log.info(`terminal created: ${id} shell=${resolved.label} cwd=${opts.cwd}`);
    return {
      ok: true,
      terminalId: id,
      pid: pty.pid,
      cwd: opts.cwd,
      shell: resolved.label
    };
  }
  write(terminalId, data) {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.write(data);
      return true;
    } catch (err) {
      log.warn(`terminal write failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  resize(terminalId, cols, rows) {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.resize(cols, rows);
      return true;
    } catch (err) {
      log.warn(`terminal resize failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  kill(terminalId) {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    this.terminals.delete(terminalId);
    try {
      live.pty.kill();
    } catch (err) {
      log.warn(`terminal kill failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
    }
    sendToRenderer(IPC.TERMINAL_EXIT, {
      channel: IPC.TERMINAL_EXIT,
      terminalId,
      exitCode: null
    });
    return true;
  }
  list(projectPath) {
    const all = [...this.terminals.values()].map((t) => t.info);
    if (!projectPath) return all;
    const norm2 = projectPath;
    return all.filter((t) => t.projectPath === norm2);
  }
  /** Kill every live PTY — call on app quit. */
  disposeAll() {
    const ids = [...this.terminals.keys()];
    for (const id of ids) {
      this.kill(id);
    }
  }
};
var TerminalManager = new TerminalManagerImpl();

// src/main/lib/mcpSync.ts
import { watch } from "node:fs";
import { promises as fs2 } from "node:fs";
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path2 from "node:path";
import { createHash } from "node:crypto";

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/util.js
function indexOfNewline(str, start = 0) {
  let idx = str.indexOf("\n", start);
  if (str.charCodeAt(idx - 1) === 13)
    idx--;
  return idx;
}
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in comments", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}
function skipUntil(ctx, sep2, end) {
  let ptr = ctx.p;
  if (!end) {
    ptr = indexOfNewline(ctx.s, ptr);
    ctx.p = ptr < 0 ? ctx.s.length : ptr;
    return;
  }
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 35) {
      skipComment(ctx);
    } else if (c === end || c === sep2) {
      return;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: ctx.s,
    ptr
  });
}

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/primitive.js
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(ctx) {
  let start = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in strings", {
        toml: ctx.s,
        ptr: ctx.p
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state)
        parsed += ctx.s.slice(sliceStart, ctx.p);
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: ctx.s, ptr: ctx.p + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: ctx.s, ptr: ctx.p });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p + 1;
        state = 0;
      } else if (c === 32 || c === 9) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: ctx.s, ptr: ctx.p });
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: ctx.s,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  throw new TomlError("unfinished string", { toml: ctx.s, ptr: start });
}
function sliceAndTrimEndOf(ctx, start, end) {
  let value = ctx.s.slice(start, end);
  let commentIdx = value.indexOf("#");
  if (commentIdx > 0) {
    skipComment({ s: value, p: commentIdx, d: 0 });
    value = value.slice(0, commentIdx);
  }
  return value.trimEnd();
}
function parseValue(ctx, integersAsBigInt, end) {
  let ptr = ctx.p;
  let err = { toml: ctx.s, ptr };
  skipUntil(ctx, 44, end);
  let value = sliceAndTrimEndOf(ctx, ptr, ctx.p);
  if (!value)
    throw new TomlError("incomplete declaration: value expected", err);
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", err);
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", err);
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", err);
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid())
    throw new TomlError("invalid value", err);
  return date;
}

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/extract.js
function extractValue(ctx, end, integersAsBigInt) {
  let ptr = ctx.p;
  let c = ctx.s.charCodeAt(ptr);
  if (c === 91 || c === 123) {
    if (!ctx.d--) {
      throw new TomlError("document contains excessively nested structures. aborting.", {
        toml: ctx.s,
        ptr
      });
    }
    let value = c === 91 ? parseArray(ctx, integersAsBigInt) : parseInlineTable(ctx, integersAsBigInt);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return false;
  }
  return parseValue(ctx, integersAsBigInt, end);
}

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/struct.js
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(ctx, end = "=") {
  let start = ctx.p;
  let dot = start - 1;
  let parsed = [];
  let endPtr = ctx.s.indexOf(end, start);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: ctx.s,
      ptr: start
    });
  }
  do {
    let c = ctx.s.charCodeAt(ctx.p = ++dot);
    if (c !== 32 && c !== 9) {
      if (c === 34 || c === 39) {
        if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        let part = parseString(ctx);
        dot = ctx.s.indexOf(".", ctx.p);
        let strEnd = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: ctx.s,
            ptr: newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        if (endPtr < ctx.p) {
          endPtr = ctx.s.indexOf(end, ctx.p);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: ctx.s,
              ptr: start
            });
          }
        }
        parsed.push(part);
      } else {
        dot = ctx.s.indexOf(".", ctx.p);
        let part = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  ctx.p = endPtr + 1;
  skipVoid(ctx, true, true);
  return parsed;
}
function parseInlineTable(ctx, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let p = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = {};
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: ctx.s,
          ptr: p
        });
      }
      if (!hasOwn && k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      throw new TomlError("trying to redefine an already defined value", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
    let value = extractValue(ctx, 125, integersAsBigInt);
    seen.add(t[k] = value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished table encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}
function parseArray(ctx, integersAsBigInt) {
  let res = [];
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(ctx, 93, integersAsBigInt));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished array encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}

// ../../node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let ctx = { s: toml, p: 0, d: maxDepth };
  let res = {};
  let meta = {};
  let tmp;
  let tbl = res;
  let m = meta;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      let k = parseKey(ctx, "]");
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p - 1) !== 93) {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: ctx.p - 1
          });
        }
        ctx.p++;
      }
      let p = peekTable(
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      m = p[2];
      tbl = p[1];
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      p[1][p[0]] = extractValue(ctx, void 0, integersAsBigInt);
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && tmp !== 13) {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr: ctx.p
      });
    }
    skipVoid(ctx);
  }
  return res;
}

// src/main/lib/mcpConfig.ts
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function userClaudeJsonPath() {
  return path.join(homedir(), ".mcode", ".claude.json");
}
var CLI_CLAUDE_JSON = path.join(homedir(), ".claude.json");
function asRecord(v2) {
  return typeof v2 === "object" && v2 !== null && !Array.isArray(v2) ? v2 : null;
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(file, value) {
  const text = JSON.stringify(value, null, 2);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.mcode-tmp`;
  try {
    await fs.writeFile(tmp, text, "utf-8");
    await fs.rename(tmp, file);
  } catch {
    try {
      await fs.rm(tmp, { force: true });
    } catch {
    }
    await fs.writeFile(file, text, "utf-8");
  }
}
async function readUserClaudeJson() {
  const parsed = await readJson(userClaudeJsonPath());
  return asRecord(parsed) ?? {};
}
async function writeUserClaudeJson(cfg) {
  await writeJson(userClaudeJsonPath(), cfg);
}
function parseMcpConfig(raw) {
  const res = McpServerConfigSchema.safeParse(raw);
  return res.success ? res.data : null;
}
function mcpServersOf(cfg) {
  return asRecord(cfg.mcpServers) ?? {};
}
async function readCliMcpSources() {
  const parsed = asRecord(await readJson(CLI_CLAUDE_JSON));
  if (!parsed) return [];
  const out = [];
  const globalServers = mcpServersOf(parsed);
  for (const [name, raw] of Object.entries(globalServers)) {
    const config = parseMcpConfig(raw);
    if (config) out.push({ name, config, origin: "\u5168\u5C40" });
  }
  const projects = asRecord(parsed.projects);
  if (projects) {
    for (const [projectPath, rawProject] of Object.entries(projects)) {
      const projectCfg = asRecord(rawProject);
      if (!projectCfg) continue;
      for (const [name, raw] of Object.entries(mcpServersOf(projectCfg))) {
        const config = parseMcpConfig(raw);
        if (config) out.push({ name, config, origin: projectPath });
      }
    }
  }
  return out;
}
async function readProjectMcpServers(projectRoot) {
  const parsed = asRecord(await readJson(path.join(projectRoot, ".mcp.json")));
  return parsed ? mcpServersOf(parsed) : {};
}
async function getMcpManagement() {
  await awaitDb();
  const raw = SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY);
  if (!raw) return {};
  return asRecord(JSON.parse(raw)) ? JSON.parse(raw) : {};
}
function saveMcpManagement(state) {
  SettingRepo.set(MCP_MANAGEMENT_SETTING_KEY, JSON.stringify(state));
}
function describeMcpConfig(config) {
  if (config.type === "http" || config.type === "sse") {
    return { kind: config.type, detail: config.url };
  }
  const parts = [config.command, ...config.args ?? []];
  const envCount = config.env ? Object.keys(config.env).length : 0;
  return {
    kind: "stdio",
    detail: envCount > 0 ? `${parts.join(" ")} \xB7 ${envCount} \u4E2A\u73AF\u5883\u53D8\u91CF` : parts.join(" ")
  };
}

// src/main/lib/mcpSync.ts
var changeListener = null;
function notifyChanged() {
  try {
    changeListener?.();
  } catch (err) {
    log.warn(`mcp sync change listener failed: ${err.message}`);
  }
}
var WATCH_DEBOUNCE_MS = 600;
var OWNERSHIP_SETTING_KEY = "mcpSync.ownership";
var runtime = /* @__PURE__ */ new Map();
var mirrorMutationTail = Promise.resolve();
async function withMirrorMutation(fn) {
  const previous = mirrorMutationTail;
  let release;
  mirrorMutationTail = new Promise((resolve3) => {
    release = resolve3;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
function emptyStatus() {
  return { serverNames: [], lastSyncAt: null, lastError: null };
}
function stateFor(id) {
  let st = runtime.get(id);
  if (!st) {
    st = { watcher: null, debounce: null, syncing: false, pendingResync: false, status: emptyStatus() };
    runtime.set(id, st);
  }
  return st;
}
async function getMcpSyncSources() {
  await awaitDb();
  const raw = SettingRepo.get(MCP_SYNC_SOURCES_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) => typeof s === "object" && s !== null && typeof s.id === "string" && typeof s.file === "string" && typeof s.label === "string" && typeof s.enabled === "boolean"
    );
  } catch {
    return [];
  }
}
function saveMcpSyncSources(sources) {
  SettingRepo.set(MCP_SYNC_SOURCES_SETTING_KEY, JSON.stringify(sources));
}
function readOwnership() {
  const raw = SettingRepo.get(OWNERSHIP_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function writeOwnership(map) {
  SettingRepo.set(OWNERSHIP_SETTING_KEY, JSON.stringify(map));
}
function sourceIdFor(file) {
  const hash = createHash("sha1").update(path2.resolve(file).toLowerCase()).digest("hex").slice(0, 10);
  const base = path2.basename(path2.dirname(path2.resolve(file))).replace(/[^\w.-]/g, "_").slice(0, 24) || "mcp";
  return `${base}-${hash}`;
}
function asRecord2(v2) {
  return typeof v2 === "object" && v2 !== null && !Array.isArray(v2) ? v2 : null;
}
var ENV_REF_RE = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%/;
function sanitizeEnv(env) {
  if (!env) return void 0;
  const out = {};
  for (const [k, v2] of Object.entries(env)) {
    if (typeof v2 !== "string") continue;
    if (ENV_REF_RE.test(v2)) continue;
    out[k] = v2;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function sanitizeConfig(cfg) {
  if (cfg.type === "http" || cfg.type === "sse") return cfg;
  const env = sanitizeEnv(cfg.env);
  if (!env) {
    const { env: _dropped, ...rest } = cfg;
    return rest;
  }
  return { ...cfg, env };
}
function codexTomlServer(raw) {
  const cfg = asRecord2(raw);
  if (!cfg) return null;
  if (typeof cfg.url === "string" && cfg.url) {
    const headers = asRecord2(cfg.http_headers);
    const config = { type: "http", url: cfg.url };
    if (headers) {
      const hs = {};
      for (const [k, v2] of Object.entries(headers)) {
        if (typeof v2 === "string") hs[k] = v2;
      }
      if (Object.keys(hs).length > 0) config.headers = hs;
    }
    return parseMcpConfig(config);
  }
  if (typeof cfg.command === "string" && cfg.command) {
    const config = { command: cfg.command };
    if (Array.isArray(cfg.args)) {
      const args = cfg.args.filter((a) => typeof a === "string");
      if (args.length > 0) config.args = args;
    }
    const env = sanitizeEnv(asRecord2(cfg.env) ?? void 0);
    if (env) config.env = env;
    return parseMcpConfig(config);
  }
  return null;
}
async function parseSourceFile(file, kind) {
  let text;
  try {
    text = await fs2.readFile(file, "utf-8");
  } catch {
    return null;
  }
  if (kind === "codex") {
    return parseCodexToml(text);
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = asRecord2(root);
  if (!rec) return null;
  const out = {};
  const merge = (servers) => {
    for (const [name, raw] of Object.entries(servers)) {
      if (name in out) continue;
      const cfg = parseMcpConfig(raw);
      if (cfg) out[name] = sanitizeConfig(cfg);
    }
  };
  merge(asRecord2(rec.mcpServers) ?? {});
  if (kind === "claude") {
    const projects = asRecord2(rec.projects);
    if (projects) {
      for (const proj of Object.values(projects)) {
        const pr = asRecord2(proj);
        if (pr) merge(asRecord2(pr.mcpServers) ?? {});
      }
    }
  }
  return out;
}
function parseCodexToml(text) {
  try {
    const root = asRecord2(parse(text));
    const servers = root ? asRecord2(root.mcp_servers) : null;
    if (!servers) return {};
    const out = {};
    for (const [name, raw] of Object.entries(servers)) {
      const cfg = codexTomlServer(raw);
      if (cfg) out[name] = cfg;
    }
    return out;
  } catch {
    return null;
  }
}
function presetSpecs() {
  const home = homedir2();
  return [
    { kind: "claude", label: "Claude Code", file: path2.join(home, ".claude.json") },
    { kind: "codex", label: "Codex", file: path2.join(home, ".codex", "config.toml") },
    { kind: "cursor", label: "Cursor", file: path2.join(home, ".cursor", "mcp.json") },
    { kind: "zcode", label: "Zcode", file: path2.join(home, ".zcode", "mcp.json") }
  ];
}
function detectKind(file) {
  const base = path2.basename(file).toLowerCase();
  if (base === "config.toml") return "codex";
  if (base === ".claude.json") return "claude";
  if (base === "mcp.json") {
    const dir = path2.basename(path2.dirname(file)).toLowerCase();
    if (dir === ".cursor") return "cursor";
    if (dir === ".zcode" || dir === ".agents") return "zcode";
  }
  return "other";
}
async function scanMcpSyncCandidates() {
  const sources = await getMcpSyncSources();
  const added = new Set(sources.map((s) => path2.resolve(s.file).toLowerCase()));
  const out = [];
  for (const spec of presetSpecs()) {
    if (!existsSync6(spec.file)) continue;
    const servers = await parseSourceFile(spec.file, spec.kind);
    out.push({
      kind: spec.kind,
      label: spec.label,
      file: spec.file,
      serverCount: servers ? Object.keys(servers).length : 0,
      added: added.has(path2.resolve(spec.file).toLowerCase())
    });
  }
  return out;
}
async function runSync(source) {
  const st = stateFor(source.id);
  if (st.syncing) {
    st.pendingResync = true;
    return;
  }
  st.syncing = true;
  try {
    const servers = await parseSourceFile(source.file, source.kind);
    if (!servers) {
      st.status.lastError = "\u6E90\u6587\u4EF6\u4E0D\u53EF\u8BFB\u6216\u89E3\u6790\u5931\u8D25";
      st.status.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
      notifyChanged();
      return;
    }
    await withMirrorMutation(async () => {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const ownership = readOwnership();
      const prevOwned = new Set(ownership[source.id] ?? []);
      const nextOwned = [];
      const conflicts = [];
      for (const name of prevOwned) {
        if (name in servers) continue;
        if (name in fileServers) delete fileServers[name];
      }
      for (const [name, config] of Object.entries(servers)) {
        if (name in fileServers && !prevOwned.has(name)) {
          conflicts.push(name);
          continue;
        }
        fileServers[name] = config;
        nextOwned.push(name);
      }
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
      ownership[source.id] = nextOwned;
      writeOwnership(ownership);
      st.status = {
        serverNames: nextOwned,
        lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastError: conflicts.length > 0 ? `\u540C\u540D\u672C\u5730\u914D\u7F6E\u4FDD\u7559:${conflicts.join(", ")}` : null
      };
      log.info(`mcpSync: ${source.label} \u2192 ${nextOwned.length} server(s) mirrored${conflicts.length ? `, ${conflicts.length} conflict(s) kept local` : ""}`);
      notifyChanged();
    });
  } catch (err) {
    st.status.lastError = err.message;
    st.status.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
    notifyChanged();
  } finally {
    st.syncing = false;
    if (st.pendingResync) {
      st.pendingResync = false;
      void runSync(source);
    }
  }
}
async function retractSource(id) {
  await withMirrorMutation(async () => {
    const ownership = readOwnership();
    const owned = ownership[id] ?? [];
    if (owned.length > 0) {
      try {
        const cfg = await readUserClaudeJson();
        const fileServers = mcpServersOf(cfg);
        for (const name of owned) delete fileServers[name];
        cfg.mcpServers = fileServers;
        await writeUserClaudeJson(cfg);
      } catch (err) {
        log.warn(`mcpSync: retract ${id} failed: ${err.message}`);
      }
    }
    delete ownership[id];
    writeOwnership(ownership);
  });
}
function clearOwnershipFor(name) {
  const ownership = readOwnership();
  let changed = false;
  for (const id of Object.keys(ownership)) {
    if (ownership[id].includes(name)) {
      ownership[id] = ownership[id].filter((n) => n !== name);
      changed = true;
    }
  }
  if (changed) writeOwnership(ownership);
}
async function startWatching(source) {
  const st = stateFor(source.id);
  stopWatching(source.id);
  await runSync(source);
  try {
    const dir = path2.dirname(source.file);
    const base = path2.basename(source.file);
    st.watcher = watch(dir, (_event, filename) => {
      if (filename && filename.toString() !== base) return;
      if (st.debounce) clearTimeout(st.debounce);
      st.debounce = setTimeout(() => {
        st.debounce = null;
        void runSync(source);
      }, WATCH_DEBOUNCE_MS);
    });
    st.watcher.on("error", (err) => {
      st.status.lastError = `\u76D1\u542C\u5931\u8D25: ${err.message}`;
      notifyChanged();
    });
  } catch (err) {
    st.status.lastError = `\u65E0\u6CD5\u76D1\u542C\u6E90\u6587\u4EF6: ${err.message}`;
    notifyChanged();
  }
}
function stopWatching(id) {
  const st = runtime.get(id);
  if (!st) return;
  if (st.debounce) clearTimeout(st.debounce);
  st.debounce = null;
  st.watcher?.close();
  st.watcher = null;
}
async function listMcpSync() {
  const sources = await getMcpSyncSources();
  return sources.map((s) => ({ ...s, status: { ...stateFor(s.id).status } }));
}
async function addMcpSyncSource(file, kind, label) {
  const resolved = path2.resolve(file);
  const stat = await fs2.stat(resolved).catch(() => null);
  if (!stat?.isFile()) return { ok: false, error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
  const sources = await getMcpSyncSources();
  const id = sourceIdFor(resolved);
  if (sources.some((s) => s.id === id)) return { ok: false, error: "\u8BE5\u6587\u4EF6\u5DF2\u5728\u540C\u6B65\u5217\u8868\u4E2D", id };
  const detected = kind ?? detectKind(resolved);
  const next = {
    id,
    label: label?.trim() || presetSpecs().find((p) => p.kind === detected)?.label || path2.basename(resolved),
    kind: detected,
    file: resolved,
    enabled: true
  };
  saveMcpSyncSources([...sources, next]);
  void startWatching(next);
  return { ok: true, id };
}
async function setMcpSyncEnabled(id, enabled) {
  const sources = await getMcpSyncSources();
  const idx = sources.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: "\u6765\u6E90\u4E0D\u5B58\u5728" };
  const next = sources.slice();
  next[idx] = { ...next[idx], enabled };
  saveMcpSyncSources(next);
  if (enabled) {
    void startWatching(next[idx]);
  } else {
    stopWatching(id);
    await retractSource(id);
    stateFor(id).status = emptyStatus();
  }
  notifyChanged();
  return { ok: true };
}
async function removeMcpSyncSource(id) {
  const sources = await getMcpSyncSources();
  const next = sources.filter((s) => s.id !== id);
  if (next.length === sources.length) return { ok: false, error: "\u6765\u6E90\u4E0D\u5B58\u5728" };
  saveMcpSyncSources(next);
  stopWatching(id);
  await retractSource(id);
  runtime.delete(id);
  notifyChanged();
  return { ok: true };
}
async function rescanMcpSync(id) {
  const sources = await getMcpSyncSources();
  const targets = id ? sources.filter((s) => s.id === id) : sources.filter((s) => s.enabled);
  if (id && targets.length === 0) return { ok: false, error: "\u6765\u6E90\u4E0D\u5B58\u5728" };
  await Promise.all(targets.map((s) => runSync(s)));
  return { ok: true };
}

// src/main/lib/pathGuard.ts
import { resolve, sep } from "node:path";
import { platform } from "node:os";
var CASE_INSENSITIVE = platform() === "win32" || platform() === "darwin";
function norm(p) {
  const r = resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}
function samePath(a, b) {
  return norm(a) === norm(b);
}

// src/main/providers/claude-sdk/customEnv.ts
import { randomBytes } from "node:crypto";
import { homedir as homedir3 } from "node:os";
import path3 from "node:path";
var MCODE_CONFIG_DIR = path3.join(homedir3(), ".mcode");
var PROCESS_SESSION_ID = `mcode-${randomBytes(6).toString("hex")}`;

// src/main/providers/claude-sdk/sdkBinaryPath.ts
import { existsSync as existsSync9 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { join as join8 } from "node:path";

// src/main/runtimes/managedRuntimeRoots.ts
import { readdirSync, statSync as statSync2 } from "node:fs";
import { join as join6 } from "node:path";
var managedRoot = null;
function getManagedRuntimeRoot() {
  return managedRoot;
}
function compareVersions(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb) && sa !== "" && sb !== "") {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}
function listManagedVersions(agent) {
  if (!managedRoot) return [];
  const dir = join6(managedRoot, agent);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const versions = [];
  for (const entry of entries) {
    try {
      if (!statSync2(join6(dir, entry)).isDirectory()) continue;
    } catch {
      continue;
    }
    versions.push(entry);
  }
  versions.sort((a, b) => compareVersions(b, a));
  return versions;
}

// src/main/runtimes/runtimeSelection.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync8, readFileSync, readdirSync as readdirSync2, realpathSync, statSync as statSync3 } from "node:fs";
import { dirname as dirname3, extname, isAbsolute, join as join7, normalize, resolve as resolve2 } from "node:path";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
var selectionKey = (agent) => `runtime.selection.${agent}`;
function readSelection(agent) {
  try {
    const raw = SettingRepo.get(selectionKey(agent));
    if (!raw) return emptyManagedSelection();
    const value = JSON.parse(raw);
    return {
      mode: value.mode === "external" ? "external" : "managed",
      path: typeof value.path === "string" && value.path.trim() ? value.path : null,
      nodePath: typeof value.nodePath === "string" && value.nodePath.trim() ? value.nodePath : null,
      verifiedVersion: typeof value.verifiedVersion === "string" ? value.verifiedVersion : null,
      payloadFingerprint: typeof value.payloadFingerprint === "string" ? value.payloadFingerprint : null,
      nodeFingerprint: typeof value.nodeFingerprint === "string" ? value.nodeFingerprint : null
    };
  } catch {
    return emptyManagedSelection();
  }
}
function emptyManagedSelection() {
  return { mode: "managed", path: null, nodePath: null, verifiedVersion: null, payloadFingerprint: null, nodeFingerprint: null };
}
function fileFingerprint(path8) {
  try {
    const st = statSync3(path8);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}
function getRuntimeSelection(agent) {
  return readSelection(agent);
}
function canonical(path8) {
  const absolute = isAbsolute(path8) ? path8 : resolve2(path8);
  try {
    return realpathSync(absolute);
  } catch {
    return normalize(absolute);
  }
}
function nativeFromCmd(path8, agent) {
  if (process.platform !== "win32" || extname(path8).toLowerCase() !== ".cmd") return path8;
  const root = dirname3(path8);
  if (agent === "claude") {
    for (const p of [
      join7(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      join7(root, "node_modules", "@anthropic-ai", "claude-code", "claude.exe")
    ]) if (existsSync8(p)) return p;
  } else {
    for (const p of [
      join7(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"),
      join7(root, "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join7(root, "node_modules", "@openai", "codex", "codex", "codex.exe")
    ]) if (existsSync8(p)) return p;
  }
  return null;
}
function normalizeExternalPath(agent, path8) {
  const p = canonical(path8);
  if (agent === "claude" || agent === "codex") return nativeFromCmd(p, agent);
  if (extname(p).toLowerCase() === ".cmd") {
    for (const scope of ["@earendil-works", "@mariozechner"]) {
      const candidate = join7(dirname3(p), "node_modules", scope, "pi-coding-agent", "package.json");
      if (existsSync8(candidate)) return candidate;
    }
    return null;
  }
  const pkg = p.endsWith("package.json") ? p : join7(p, "package.json");
  if (existsSync8(pkg)) return pkg;
  let ancestor = existsSync8(p) && extname(p) === ".js" ? dirname3(p) : p;
  for (let i = 0; i < 6; i++) {
    const candidate = join7(ancestor, "package.json");
    if (existsSync8(candidate)) {
      try {
        const name = JSON.parse(readFileSync(candidate, "utf8")).name;
        if (name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent") return candidate;
      } catch {
      }
    }
    const parent = dirname3(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const nested = join7(p, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  return existsSync8(nested) ? nested : null;
}
function resolveExternalRuntimeSync(agent) {
  const selection = readSelection(agent);
  if (selection.mode !== "external" || !selection.path) return null;
  const path8 = normalizeExternalPath(agent, selection.path);
  if (!path8 || !existsSync8(path8) || !selection.payloadFingerprint || fileFingerprint(path8) !== selection.payloadFingerprint) return null;
  return { source: "external", path: path8, version: selection.verifiedVersion };
}

// src/main/providers/claude-sdk/sdkBinaryPath.ts
function platformSuffix() {
  return `${process.platform}-${process.arch}`;
}
function binaryNames() {
  return process.platform === "win32" ? ["claude.exe"] : ["claude"];
}
function toUnpackedPath(p) {
  return p.includes("app.asar") ? p.replace("app.asar", "app.asar.unpacked") : p;
}
function resolveSdkBinaryPath() {
  const selection = getRuntimeSelection("claude");
  if (selection.mode === "external") {
    const resolved = resolveExternalRuntimeSync("claude");
    if (resolved) return resolved.path;
    throw new Error(selection.path ? `Configured external Claude runtime is unavailable: ${selection.path}. Choose a valid native Claude executable in Settings.` : "Claude external runtime is selected but no executable is configured. Choose a detected installation in Settings.");
  }
  const managedRoot2 = getManagedRuntimeRoot();
  if (managedRoot2) {
    for (const version of listManagedVersions("claude")) {
      for (const name of binaryNames()) {
        const candidate = join8(managedRoot2, "claude", version, name);
        if (existsSync9(candidate)) return candidate;
      }
    }
  }
  return resolveBundledSdkBinaryPath();
}
function resolveBundledSdkBinaryPath() {
  if (!!process.env["ELECTRON_RENDERER_URL"]) return null;
  const suffix = platformSuffix();
  const pkg = `@anthropic-ai/claude-agent-sdk-${suffix}`;
  const req = createRequire2(import.meta.url);
  for (const name of binaryNames()) {
    let resolved = null;
    try {
      resolved = req.resolve(`${pkg}/${name}`);
    } catch {
    }
    if (resolved) {
      const unpacked = toUnpackedPath(resolved);
      if (existsSync9(unpacked)) return unpacked;
      if (existsSync9(resolved)) return unpacked;
    }
    if (process.resourcesPath) {
      const direct = join8(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        pkg,
        // already "@anthropic-ai/claude-agent-sdk-<plat>-<arch>"
        name
      );
      if (existsSync9(direct)) return direct;
    }
  }
  return null;
}

// src/main/plugins/pluginManager.ts
import { existsSync as existsSync11, readdirSync as readdirSync4, readFileSync as readFileSync3, rmSync, statSync as statSync4 } from "node:fs";
import path5 from "node:path";

// src/main/plugins/pluginManifest.ts
import { existsSync as existsSync10, readdirSync as readdirSync3, readFileSync as readFileSync2 } from "node:fs";
import path4 from "node:path";
function findPluginManifest(root) {
  for (const dir of PLUGIN_MANIFEST_DIRS) {
    const file = path4.join(root, dir, "plugin.json");
    if (!existsSync10(file)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync2(file, "utf-8"));
    } catch {
      throw new Error(`\u63D2\u4EF6\u6E05\u5355\u65E0\u6CD5\u89E3\u6790:${path4.join(dir, "plugin.json")} \u4E0D\u662F\u5408\u6CD5 JSON`);
    }
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `\u63D2\u4EF6\u6E05\u5355\u6821\u9A8C\u5931\u8D25(${path4.join(dir, "plugin.json")}):${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`
      );
    }
    return { manifest: parsed.data, rootDir: root, manifestDir: dir };
  }
  return null;
}
var MARKETPLACE_MANIFEST_RELS = [
  path4.join(".claude-plugin", "marketplace.json"),
  "marketplace.json"
];
function readFrontmatter(file) {
  let text;
  try {
    text = readFileSync2(file, "utf-8");
  } catch {
    return {};
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
function resolveInRoot(root, rel) {
  if (!rel || path4.isAbsolute(rel)) return null;
  const abs = path4.resolve(root, rel);
  const relBack = path4.relative(root, abs);
  if (!relBack || relBack.startsWith("..") || path4.isAbsolute(relBack)) return null;
  return existsSync10(abs) ? abs : null;
}
function componentPaths(value, fallback) {
  if (value === void 0) return [fallback];
  return Array.isArray(value) ? value : [value];
}
function resolveAllInRoot(root, rels) {
  return rels.map((rel) => resolveInRoot(root, rel)).filter((p) => p !== null);
}
function pluginSkillsDirs(root, manifest) {
  return resolveAllInRoot(root, componentPaths(manifest.skills, "skills"));
}
function pluginCommandsDirs(root, manifest) {
  return resolveAllInRoot(root, componentPaths(manifest.commands, "commands"));
}
function pluginAgentsDirs(root, manifest) {
  return resolveAllInRoot(root, componentPaths(manifest.agents, "agents"));
}
function pluginHooksFiles(root, manifest) {
  return resolveAllInRoot(root, componentPaths(manifest.hooks, "hooks/hooks.json"));
}
function pluginMcpFiles(root, manifest) {
  return resolveAllInRoot(root, componentPaths(manifest.mcpServers, ".mcp.json"));
}
function scanSkillDirs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync3(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fm = readFrontmatter(path4.join(dir, e.name, "SKILL.md"));
    out.push({ name: fm.name || e.name, description: fm.description ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function scanMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync3(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const base = e.name.slice(0, -3);
    const fm = readFrontmatter(path4.join(dir, e.name));
    out.push({ name: fm.name || base, description: fm.description ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function parseHooksFile(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync2(file, "utf-8"));
  } catch {
    return [{ event: "(unknown)", command: "(hooks \u6587\u4EF6\u65E0\u6CD5\u89E3\u6790)" }];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [{ event: "(unknown)", command: "(hooks \u5B9A\u4E49\u683C\u5F0F\u4E0D\u53D7\u652F\u6301)" }];
  }
  const out = [];
  for (const [event, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== "object") continue;
      const group = g;
      const matcher = typeof group.matcher === "string" ? group.matcher : void 0;
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of hooks) {
        if (!h || typeof h !== "object") continue;
        const hook = h;
        const command = typeof hook.command === "string" ? hook.command : JSON.stringify(hook);
        out.push(matcher ? { event, matcher, command } : { event, command });
      }
    }
  }
  if (out.length === 0) return [{ event: "(unknown)", command: "(hooks \u5B9A\u4E49\u4E3A\u7A7A)" }];
  return out;
}
function describePluginMcp(config) {
  if (!config || typeof config !== "object") return null;
  const cfg = config;
  if (cfg.type === "http" || cfg.type === "sse") {
    if (typeof cfg.url !== "string" || !cfg.url) return null;
    return { kind: cfg.type, detail: cfg.url };
  }
  if (typeof cfg.command !== "string" || !cfg.command) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === "string") : [];
  return { kind: "stdio", detail: [cfg.command, ...args].join(" ") };
}
function summarizeComponents(root, manifest) {
  const mcpServers = [];
  for (const mcpFile of pluginMcpFiles(root, manifest)) {
    try {
      const cfg = JSON.parse(readFileSync2(mcpFile, "utf-8"));
      const servers = cfg.mcpServers ?? cfg;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const [name, raw] of Object.entries(servers)) {
          const desc = describePluginMcp(raw);
          if (desc) mcpServers.push({ name, kind: desc.kind, detail: desc.detail });
        }
      }
    } catch {
    }
  }
  const skills = pluginSkillsDirs(root, manifest).flatMap(scanSkillDirs).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const commands = pluginCommandsDirs(root, manifest).flatMap(scanMarkdownFiles).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const agents = pluginAgentsDirs(root, manifest).flatMap(scanMarkdownFiles).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const hooks = pluginHooksFiles(root, manifest).flatMap(parseHooksFile);
  return {
    skills,
    commands,
    agents,
    hooks,
    mcpServers
  };
}

// src/main/plugins/pluginManager.ts
var PLUGINS_ROOT = path5.join(MCODE_CONFIG_DIR, "plugins");
var MARKETPLACES_DIR = path5.join(PLUGINS_ROOT, "marketplaces");
function readJsonSetting(key, fallback) {
  try {
    const raw = SettingRepo.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJsonSetting(key, value) {
  SettingRepo.set(key, JSON.stringify(value));
}
function readEnabledPlugins() {
  const names = readJsonSetting(PLUGINS_ENABLED_SETTING_KEY, []);
  return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
}
function readMcpDisabled() {
  const names = readJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, []);
  return new Set(Array.isArray(names) ? names.filter((n) => typeof n === "string") : []);
}
function installedRootOf(name) {
  const base = path5.join(PLUGINS_ROOT, name);
  if (!existsSync11(base)) return null;
  let newest = null;
  for (const entry of readdirSync4(base)) {
    const dir = path5.join(base, entry);
    try {
      if (!statSync4(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!newest || entry > newest) newest = entry;
  }
  return newest ? path5.join(base, newest) : null;
}
function normalizeGitUrl(url) {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
var BUILTIN_MARKETPLACE_URLS = new Set(BUILTIN_MARKETPLACES.map((b) => normalizeGitUrl(b.url)));
async function getEnabledPlugins() {
  const enabledNames = new Set(readEnabledPlugins());
  if (enabledNames.size === 0) return [];
  const out = [];
  for (const name of enabledNames) {
    const rootDir = installedRootOf(name);
    if (!rootDir) continue;
    try {
      const resolved = findPluginManifest(rootDir);
      if (!resolved) continue;
      const hasHooks = summarizeComponents(rootDir, resolved.manifest).hooks.length > 0;
      out.push({ name: resolved.manifest.name, rootDir, manifest: resolved.manifest, hasHooks });
    } catch {
    }
  }
  return out;
}
function readPluginMcpEntries(p) {
  const out = [];
  for (const file of pluginMcpFiles(p.rootDir, p.manifest)) {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync3(file, "utf-8"));
    } catch {
      continue;
    }
    const servers = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg.mcpServers ?? cfg : null;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [serverName, raw] of Object.entries(servers)) {
      out.push([serverName, raw]);
    }
  }
  return out;
}
async function getPluginMcpServerConfig(fullName) {
  for (const p of await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      if (`${p.name}__${serverName}` === fullName) return raw;
    }
  }
  return null;
}
async function getPluginMcpServers(precomputed) {
  const disabled = readMcpDisabled();
  const out = [];
  for (const p of precomputed ?? await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const parsed = McpServerConfigSchema.safeParse(raw);
      if (!parsed.success) continue;
      const fullName = `${p.name}__${serverName}`;
      if (disabled.has(fullName)) continue;
      out.push([fullName, parsed.data]);
    }
  }
  return out;
}
function setPluginMcpDisabled(serverName, disabledValue) {
  const next = new Set([...readMcpDisabled()].filter((n) => n !== serverName));
  if (disabledValue) next.add(serverName);
  writeJsonSetting(PLUGINS_MCP_DISABLED_SETTING_KEY, [...next]);
  return { ok: true };
}
async function listPluginMcpPanelEntries() {
  const disabled = readMcpDisabled();
  const out = [];
  for (const p of await getEnabledPlugins()) {
    for (const [serverName, raw] of readPluginMcpEntries(p)) {
      const desc = describePluginMcp(raw);
      if (!desc) continue;
      const fullName = `${p.name}__${serverName}`;
      out.push({
        name: fullName,
        scope: "plugin",
        kind: desc.kind,
        detail: desc.detail,
        enabled: !disabled.has(fullName)
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// src/main/ipc/mcp.ts
function findKnownProject(projectPath) {
  return ProjectRepo.list().find((p) => samePath(p.path, projectPath));
}
var BUILTIN_DETAIL = "browser_navigate / browser_snapshot / browser_click \u7B49\u5E94\u7528\u5185\u6D4F\u89C8\u5668\u5DE5\u5177";
var NEEDS_AUTH_CACHE_FILE = path6.join(MCODE_CONFIG_DIR, "mcp-needs-auth-cache.json");
function readNeedsAuthNames() {
  try {
    const raw = JSON.parse(readFileSync4(NEEDS_AUTH_CACHE_FILE, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return /* @__PURE__ */ new Set();
    return new Set(Object.keys(raw));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function forgetNeedsAuth(name) {
  try {
    if (!existsSync12(NEEDS_AUTH_CACHE_FILE)) return;
    const raw = JSON.parse(readFileSync4(NEEDS_AUTH_CACHE_FILE, "utf-8"));
    if (!(name in raw)) return;
    delete raw[name];
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
  }
}
function markNeedsAuth(name) {
  try {
    const raw = existsSync12(NEEDS_AUTH_CACHE_FILE) ? JSON.parse(readFileSync4(NEEDS_AUTH_CACHE_FILE, "utf-8")) : {};
    raw[name] = { timestamp: Date.now() };
    writeFileSync(NEEDS_AUTH_CACHE_FILE, JSON.stringify(raw), "utf-8");
  } catch {
  }
}
function darwinCredentialsService() {
  const suffix = createHash2("sha256").update(MCODE_CONFIG_DIR.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}
var KEYCHAIN_READ_TIMEOUT_MS = 2500;
function readCredentialsBlob() {
  if (process.platform !== "darwin") {
    const file = path6.join(MCODE_CONFIG_DIR, ".credentials.json");
    if (!existsSync12(file)) return { readable: true, text: null };
    try {
      return { readable: true, text: readFileSync4(file, "utf-8") };
    } catch {
      return { readable: false, text: null };
    }
  }
  const account = process.env.USER || userInfo().username || "claude-code-user";
  const res = spawnSync(
    "security",
    ["find-generic-password", "-a", account, "-w", "-s", darwinCredentialsService()],
    { encoding: "utf-8", timeout: KEYCHAIN_READ_TIMEOUT_MS }
  );
  if (res.error) return { readable: false, text: null };
  if (res.status !== 0) {
    const stderr = String(res.stderr ?? "");
    return /could not be found/i.test(stderr) ? { readable: true, text: null } : { readable: false, text: null };
  }
  return { readable: true, text: res.stdout?.trim() || null };
}
function readStoredCredentials() {
  const { readable, text } = readCredentialsBlob();
  const names = /* @__PURE__ */ new Set();
  if (text === null) return { names, readable };
  try {
    const raw = JSON.parse(text);
    for (const entry of Object.values(raw.mcpOAuth ?? {})) {
      if (entry.serverName && typeof entry.accessToken === "string" && entry.accessToken.length > 0) {
        names.add(entry.serverName);
      }
    }
    return { names, readable: true };
  } catch {
    return { names, readable: false };
  }
}
async function resolveRemoteServerConfig(name, fallback, scope, projectPath) {
  const asRemote = (raw) => {
    const config = parseMcpConfig(raw);
    if (!config || config.type !== "http" && config.type !== "sse") return null;
    return { type: config.type, url: config.url, ...config.headers ? { headers: config.headers } : {} };
  };
  const fromUserFile = async () => asRemote(mcpServersOf(await readUserClaudeJson())[name]);
  const fromStash = async () => asRemote((await getMcpManagement()).userDisabled?.[name]);
  const fromPlugin = async () => asRemote(await getPluginMcpServerConfig(name));
  const fromProjects = async () => {
    const roots = projectPath ? [projectPath, ...ProjectRepo.list().map((p) => p.path)] : ProjectRepo.list().map((p) => p.path);
    for (const root of roots) {
      const found = asRemote((await readProjectMcpServers(root))[name]);
      if (found) return found;
    }
    return null;
  };
  const loaders = [];
  if (scope === "user") loaders.push(fromUserFile, fromStash);
  if (scope === "plugin") loaders.push(fromPlugin);
  if (scope === "project") loaders.push(fromProjects);
  loaders.push(fromUserFile, fromStash, fromPlugin, fromProjects);
  const tried = /* @__PURE__ */ new Set();
  for (const load of loaders) {
    if (tried.has(load)) continue;
    tried.add(load);
    const found = await load();
    if (found) return found;
  }
  return { type: fallback.kind, url: fallback.url };
}
var AUTH_PROBE_TIMEOUT_MS = 5e3;
var AUTH_PROBE_TTL_MS = 5 * 6e4;
var AUTH_PROBE_BUDGET_MS = 2500;
var authProbeCache = /* @__PURE__ */ new Map();
function authProbeKey(name, url) {
  return `${name}|${url}`;
}
async function probeRequiresAuth(config) {
  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...config.headers ?? {}
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcode", version: "1.0" }
        }
      }),
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS)
    });
    try {
      await res.body?.cancel();
    } catch {
    }
    if (res.status !== 401 && res.status !== 403) return false;
    return /^bearer\b/i.test(res.headers.get("www-authenticate") ?? "");
  } catch {
    return null;
  }
}
async function probeAll(entries) {
  if (entries.length === 0) return;
  const work = entries.map(async ({ key, config }) => {
    const requiresAuth = await probeRequiresAuth(config);
    if (requiresAuth !== null) authProbeCache.set(key, { requiresAuth, at: Date.now() });
  });
  await Promise.race([
    Promise.all(work),
    new Promise((resolve3) => setTimeout(resolve3, AUTH_PROBE_BUDGET_MS))
  ]);
  void Promise.allSettled(work);
}
var ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)/g;
function runCaptured(cmd, args, opts) {
  return new Promise((resolve3) => {
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve3(r);
    };
    let pty;
    try {
      pty = loadNodePty().spawn(cmd, args, {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: MCODE_CONFIG_DIR,
        // node-pty's env type wants strings; drop undefined values.
        env: Object.fromEntries(
          Object.entries(opts.env ?? process.env).filter(([, v2]) => v2 !== void 0)
        )
      });
    } catch (err) {
      finish({ ok: false, message: err.message, spawnFailed: true });
      return;
    }
    let tail = "";
    pty.onData((d) => {
      tail = (tail + d).slice(-2e3);
    });
    pty.onExit(
      ({ exitCode }) => finish(
        exitCode === 0 ? { ok: true, message: "", spawnFailed: false } : {
          ok: false,
          message: `\u9000\u51FA\u7801 ${exitCode}:${tail.replace(ANSI_RE, "").trim().slice(-400) || "(\u65E0\u8F93\u51FA)"}`,
          spawnFailed: false
        }
      )
    );
    setTimeout(() => {
      try {
        pty.write("\r");
      } catch {
      }
    }, 2e3);
    timer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
      }
      finish({
        ok: false,
        message: `\u6388\u6743\u8D85\u65F6(${Math.round(opts.timeoutMs / 1e3)}s):\u8BF7\u786E\u8BA4\u5DF2\u5728\u6D4F\u89C8\u5668\u4E2D\u5B8C\u6210\u767B\u5F55`,
        spawnFailed: false
      });
    }, opts.timeoutMs);
  });
}
function registerMcpHandlers(ipcMain2) {
  ipcMain2.handle(IPC.MCP_LIST, async (_evt, raw) => {
    const input = McpListSchema.parse(raw);
    const state = await getMcpManagement();
    const servers = [];
    const remoteConfigs = /* @__PURE__ */ new Map();
    const rowKey = (scope, name) => `${scope}:${name}`;
    const rememberRemote = (scope, name, config) => {
      if (config.type !== "http" && config.type !== "sse") return;
      remoteConfigs.set(rowKey(scope, name), {
        type: config.type,
        url: config.url,
        ...config.headers ? { headers: config.headers } : {}
      });
    };
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    for (const [name, rawConfig] of Object.entries(fileServers)) {
      const config = parseMcpConfig(rawConfig);
      if (!config) continue;
      const { kind, detail } = describeMcpConfig(config);
      rememberRemote("user", name, config);
      servers.push({ name, scope: "user", kind, detail, enabled: true });
    }
    for (const [name, config] of Object.entries(state.userDisabled ?? {})) {
      if (name in fileServers) continue;
      const { kind, detail } = describeMcpConfig(config);
      rememberRemote("user", name, config);
      servers.push({ name, scope: "user", kind, detail, enabled: false });
    }
    if (input.projectPath) {
      const project = findKnownProject(input.projectPath);
      if (project) {
        const enabledNames = new Set(
          (state.projectEnabled ?? []).filter((e) => samePath(e.projectPath, project.path)).map((e) => e.name)
        );
        for (const [name, rawConfig] of Object.entries(await readProjectMcpServers(project.path))) {
          const config = parseMcpConfig(rawConfig);
          if (!config) continue;
          const { kind, detail } = describeMcpConfig(config);
          rememberRemote("project", name, config);
          servers.push({ name, scope: "project", kind, detail, enabled: enabledNames.has(name) });
        }
      }
    }
    const pluginConfigs = new Map(await getPluginMcpServers());
    for (const entry of await listPluginMcpPanelEntries()) {
      servers.push(entry);
      const config = pluginConfigs.get(entry.name);
      if (config) rememberRemote("plugin", entry.name, config);
    }
    servers.push({
      name: MCP_RESERVED_NAME,
      scope: "builtin",
      kind: "builtin",
      detail: BUILTIN_DETAIL,
      enabled: !state.browserDisabled
    });
    const needsAuth = readNeedsAuthNames();
    const stored = readStoredCredentials();
    const probes = [];
    for (const s of servers) {
      if (s.kind !== "http" && s.kind !== "sse") continue;
      if (needsAuth.has(s.name)) {
        s.needsAuth = true;
        continue;
      }
      if (stored.names.has(s.name)) {
        s.authorized = true;
        continue;
      }
      const config = remoteConfigs.get(rowKey(s.scope, s.name));
      if (!s.enabled || !config) continue;
      const key = authProbeKey(s.name, config.url);
      const cached = authProbeCache.get(key);
      if (cached && Date.now() - cached.at < AUTH_PROBE_TTL_MS) {
        if (cached.requiresAuth) s.needsAuth = true;
        continue;
      }
      probes.push({ key, config });
    }
    await probeAll(probes);
    for (const s of servers) {
      if (s.needsAuth || s.authorized) continue;
      const config = remoteConfigs.get(rowKey(s.scope, s.name));
      if (config && authProbeCache.get(authProbeKey(s.name, config.url))?.requiresAuth) s.needsAuth = true;
    }
    servers.sort(
      (a, b) => a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : b.scope === "user" ? 1 : a.scope === "project" ? -1 : b.scope === "plugin" ? -1 : 1
    );
    return { servers };
  });
  ipcMain2.handle(IPC.MCP_TOGGLE, async (_evt, raw) => {
    const input = McpToggleSchema.parse(raw);
    try {
      if (input.scope === "builtin") {
        const state2 = await getMcpManagement();
        state2.browserDisabled = !input.enabled;
        saveMcpManagement(state2);
        return { ok: true };
      }
      if (input.scope === "plugin") {
        return setPluginMcpDisabled(input.name, !input.enabled);
      }
      if (input.scope === "project") {
        if (!input.projectPath) return { ok: false, error: "\u7F3A\u5C11 projectPath" };
        const project = findKnownProject(input.projectPath);
        if (!project) return { ok: false, error: "\u672A\u77E5\u7684\u9879\u76EE\u8DEF\u5F84" };
        const state2 = await getMcpManagement();
        const list = state2.projectEnabled ?? [];
        if (input.enabled) {
          if (!list.some((e) => samePath(e.projectPath, project.path) && e.name === input.name)) {
            list.push({ projectPath: project.path, name: input.name });
          }
          state2.projectEnabled = list;
        } else {
          state2.projectEnabled = list.filter(
            (e) => !(samePath(e.projectPath, project.path) && e.name === input.name)
          );
        }
        saveMcpManagement(state2);
        return { ok: true };
      }
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      if (input.enabled) {
        const config = stash[input.name];
        if (!config) {
          if (!(input.name in fileServers)) return { ok: false, error: "\u672A\u627E\u5230\u8BE5 server \u7684\u914D\u7F6E" };
          return { ok: true };
        }
        fileServers[input.name] = config;
        delete stash[input.name];
      } else {
        const rawConfig = fileServers[input.name];
        const config = parseMcpConfig(rawConfig);
        if (!config) return { ok: false, error: "\u672A\u627E\u5230\u8BE5 server \u7684\u914D\u7F6E" };
        delete fileServers[input.name];
        stash[input.name] = config;
      }
      cfg.mcpServers = fileServers;
      state.userDisabled = stash;
      await writeUserClaudeJson(cfg);
      saveMcpManagement(state);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain2.handle(IPC.MCP_AUTHORIZE, async (_evt, raw) => {
    const input = McpAuthorizeSchema.parse(raw);
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "\u975E\u6CD5 server \u540D" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "\u4EC5\u652F\u6301 http(s) \u5730\u5740" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "\u672A\u627E\u5230 Claude CLI \u8FD0\u884C\u65F6:\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 Agent\u300D\u5B89\u88C5\u540E\u518D\u8BD5\u3002" };
    }
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    const target = await resolveRemoteServerConfig(input.name, { kind: input.kind, url: input.url }, input.scope, input.projectPath);
    try {
      fileServers[input.name] = target;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "login", input.name], { env, timeoutMs: 3e5 });
      if (!res.ok) {
        return { ok: false, error: res.message || "claude mcp login \u5931\u8D25" };
      }
      const stored = readStoredCredentials();
      if (stored.readable && !stored.names.has(input.name)) {
        return { ok: false, error: res.message || "CLI \u62A5\u544A\u6210\u529F,\u4F46\u672A\u627E\u5230\u5DF2\u5B58\u50A8\u7684\u6388\u6743\u4EE4\u724C" };
      }
      forgetNeedsAuth(input.name);
      authProbeCache.delete(authProbeKey(input.name, target.url));
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
      }
    }
  });
  ipcMain2.handle(IPC.MCP_UNAUTHORIZE, async (_evt, raw) => {
    const input = McpUnauthorizeSchema.parse(raw);
    if (!/^[A-Za-z0-9_-]+$/.test(input.name)) return { ok: false, error: "\u975E\u6CD5 server \u540D" };
    if (!/^https?:\/\/[^\s"'`<>^|]*$/.test(input.url)) {
      return { ok: false, error: "\u4EC5\u652F\u6301 http(s) \u5730\u5740" };
    }
    const before = readStoredCredentials();
    if (before.readable && !before.names.has(input.name)) {
      return { ok: false, error: "\u8BE5 server \u6CA1\u6709\u5DF2\u5B58\u50A8\u7684\u6388\u6743" };
    }
    const claudeBin = resolveSdkBinaryPath();
    if (!claudeBin) {
      return { ok: false, error: "\u672A\u627E\u5230 Claude CLI \u8FD0\u884C\u65F6:\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 Agent\u300D\u5B89\u88C5\u540E\u518D\u8BD5\u3002" };
    }
    const cfg = await readUserClaudeJson();
    const fileServers = mcpServersOf(cfg);
    const existed = fileServers[input.name];
    const target = await resolveRemoteServerConfig(input.name, { kind: input.kind, url: input.url }, input.scope, input.projectPath);
    try {
      fileServers[input.name] = target;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
      const env = { ...process.env, CLAUDE_CONFIG_DIR: MCODE_CONFIG_DIR };
      const res = await runCaptured(claudeBin, ["mcp", "logout", input.name], { env, timeoutMs: 6e4 });
      if (!res.ok) return { ok: false, error: res.message || "claude mcp logout \u5931\u8D25" };
      const after = readStoredCredentials();
      if (after.readable && after.names.has(input.name)) {
        log.warn(`mcp logout: ${input.name} still has a stored token after a successful CLI logout`);
      }
      markNeedsAuth(input.name);
      return { ok: true };
    } finally {
      try {
        const restore = await readUserClaudeJson();
        const servers = mcpServersOf(restore);
        if (existed) servers[input.name] = existed;
        else delete servers[input.name];
        restore.mcpServers = servers;
        await writeUserClaudeJson(restore);
      } catch {
      }
    }
  });
  ipcMain2.handle(IPC.MCP_SAVE, async (_evt, raw) => {
    const input = McpSaveSchema.parse(raw);
    if (input.name === MCP_RESERVED_NAME) {
      return { ok: false, error: `\u300C${MCP_RESERVED_NAME}\u300D\u662F\u5185\u7F6E server \u7684\u4FDD\u7559\u540D` };
    }
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      if (input.name in fileServers || state.userDisabled?.[input.name]) {
        return { ok: false, error: "\u540C\u540D server \u5DF2\u5B58\u5728" };
      }
      fileServers[input.name] = input.config;
      cfg.mcpServers = fileServers;
      await writeUserClaudeJson(cfg);
      clearOwnershipFor(input.name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain2.handle(IPC.MCP_REMOVE, async (_evt, raw) => {
    const input = McpRemoveSchema.parse(raw);
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      const inFile = input.name in fileServers;
      const inStash = input.name in stash;
      if (!inFile && !inStash) return { ok: false, error: "\u672A\u627E\u5230\u8BE5 server" };
      if (inFile) delete fileServers[input.name];
      if (inStash) delete stash[input.name];
      cfg.mcpServers = fileServers;
      state.userDisabled = stash;
      await writeUserClaudeJson(cfg);
      saveMcpManagement(state);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain2.handle(IPC.MCP_SCAN_IMPORT, async (_evt, raw) => {
    McpScanImportSchema.parse(raw);
    const sources = (await readCliMcpSources()).map((s) => ({
      name: s.name,
      origin: s.origin,
      config: s.config,
      ...describeMcpConfig(s.config)
    }));
    return { sources };
  });
  ipcMain2.handle(IPC.MCP_IMPORT, async (_evt, raw) => {
    const input = McpImportSchema.parse(raw);
    const imported = [];
    const skipped = [];
    const errors = [];
    try {
      const cfg = await readUserClaudeJson();
      const fileServers = mcpServersOf(cfg);
      const state = await getMcpManagement();
      const stash = state.userDisabled ?? {};
      let changed = false;
      for (const item of input.servers) {
        if (item.name in fileServers || item.name in stash) {
          skipped.push(item.name);
          continue;
        }
        fileServers[item.name] = item.config;
        imported.push(item.name);
        clearOwnershipFor(item.name);
        changed = true;
      }
      if (changed) {
        cfg.mcpServers = fileServers;
        await writeUserClaudeJson(cfg);
      }
      return { imported, skipped, errors };
    } catch (err) {
      return {
        imported,
        skipped,
        errors: [...errors, { name: "(\u6279\u91CF\u5199\u5165)", error: err.message }]
      };
    }
  });
  ipcMain2.handle(IPC.MCP_SYNC_LIST, async (_evt, raw) => {
    McpSyncListSchema.parse(raw);
    return { sources: await listMcpSync() };
  });
  ipcMain2.handle(IPC.MCP_SYNC_SCAN, async (_evt, raw) => {
    McpSyncScanSchema.parse(raw);
    return { candidates: await scanMcpSyncCandidates() };
  });
  ipcMain2.handle(IPC.MCP_SYNC_ADD, async (_evt, raw) => {
    const input = McpSyncAddSchema.parse(raw);
    return addMcpSyncSource(input.file, input.kind, input.label);
  });
  ipcMain2.handle(IPC.MCP_SYNC_SET_ENABLED, async (_evt, raw) => {
    const input = McpSyncSetEnabledSchema.parse(raw);
    return setMcpSyncEnabled(input.id, input.enabled);
  });
  ipcMain2.handle(IPC.MCP_SYNC_REMOVE, async (_evt, raw) => {
    const input = McpSyncRemoveSchema.parse(raw);
    return removeMcpSyncSource(input.id);
  });
  ipcMain2.handle(IPC.MCP_SYNC_RESCAN, async (_evt, raw) => {
    const input = McpSyncRescanSchema.parse(raw);
    return rescanMcpSync(input.id);
  });
}

// ../../scripts/mcp-sync-smoke/main.ts
async function main() {
  const userData = fs3.mkdtempSync(path7.join(os.tmpdir(), "mcode-mcp-smoke-"));
  process.env.USERPROFILE = userData;
  process.env.HOME = userData;
  app3.setPath("userData", userData);
  await app3.whenReady();
  await initDb();
  await awaitDb();
  registerMcpHandlers(ipcMain);
  const preload = path7.resolve(process.cwd(), "out/preload/index.mjs");
  const win = new BrowserWindow2({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    process.stderr.write(`[preload-error] ${preloadPath}: ${error.stack || error.message}
`);
  });
  await win.loadURL("data:text/html,<title>smoke</title>");
  win.webContents.on("console-message", (_e, _l, msg) => process.stdout.write("[renderer] " + msg + "\n"));
  const target = path7.join(os.homedir(), ".mcode", ".claude.json");
  const codexFile = path7.join(os.homedir(), ".codex", "config.toml");
  const cursorFile = path7.join(os.homedir(), ".cursor", "mcp.json");
  fs3.mkdirSync(path7.dirname(codexFile), { recursive: true });
  fs3.mkdirSync(path7.dirname(cursorFile), { recursive: true });
  fs3.writeFileSync(codexFile, [
    "[mcp_servers.node_repl]",
    'command = "node"',
    'args = ["-e", "console.log(1)"]',
    ""
  ].join("\n"));
  fs3.writeFileSync(cursorFile, JSON.stringify({
    mcpServers: {
      "cursor-fixture": { command: "node", args: ["-e", "console.log(2)"] }
    }
  }, null, 2));
  const js = (body) => win.webContents.executeJavaScript(`(async () => { const mcp = window.api.mcp; ${body} })()`);
  const servers = () => {
    try {
      return Object.keys(JSON.parse(fs3.readFileSync(target, "utf8")).mcpServers || {});
    } catch (e) {
      return "READ_ERR:" + String(e);
    }
  };
  const r = {};
  r.serversBefore = servers();
  const waitFor = async (fn, want, ms = 4e3) => {
    const t0 = Date.now();
    for (; ; ) {
      const v2 = fn();
      if (want(v2)) return v2;
      if (Date.now() - t0 > ms) return v2;
      await new Promise((r2) => setTimeout(r2, 120));
    }
  };
  r.addCodex = await js(`return mcp.syncAdd({ kind: "codex", file: ${JSON.stringify(codexFile)} });`);
  await js(`return mcp.syncRescan({});`);
  r.serversAfterCodex = await waitFor(servers, (v2) => Array.isArray(v2) && v2.length > 0);
  r.addCursor = await js(`return mcp.syncAdd({ kind: "cursor", file: ${JSON.stringify(cursorFile)} });`);
  await js(`return mcp.syncRescan({});`);
  r.serversAfterCursor = await waitFor(servers, (v2) => Array.isArray(v2) && v2.length >= 2);
  r.listAfterAdd = await js(`return (await mcp.syncList({})).sources.map((s) => ({ kind: s.kind, enabled: s.enabled, servers: s.status.serverCount, err: s.status.lastError || null }));`);
  const codexId = r.addCodex.id ?? null;
  r.codexId = codexId;
  if (codexId) {
    const codexNames = r.serversAfterCodex;
    await js(`return mcp.syncSetEnabled({ id: ${JSON.stringify(codexId)}, enabled: false });`);
    r.serversAfterDisable = await waitFor(servers, (v2) => Array.isArray(v2) && !v2.some((n) => codexNames.includes(n)));
    await js(`return mcp.syncSetEnabled({ id: ${JSON.stringify(codexId)}, enabled: true });`);
    await js(`return mcp.syncRescan({});`);
    r.serversAfterReenable = await waitFor(servers, (v2) => Array.isArray(v2) && v2.some((n) => codexNames.includes(n)));
    await js(`return mcp.syncRemove({ id: ${JSON.stringify(codexId)} });`);
    r.serversAfterRemove = await waitFor(servers, (v2) => Array.isArray(v2) && !v2.some((n) => codexNames.includes(n)));
    r.listFinal = await js(`return (await mcp.syncList({})).sources.map((s) => ({ kind: s.kind, enabled: s.enabled }));`);
  }
  const remaining = await js(`return (await mcp.syncList({})).sources.map((s) => s.id);`);
  for (const id of remaining) {
    await js(`return mcp.syncRemove({ id: ${JSON.stringify(id)} });`);
  }
  r.serversAfterCleanup = await waitFor(servers, (v2) => Array.isArray(v2) && v2.length === 0);
  const includes = (value, name) => Array.isArray(value) && value.includes(name);
  const excludes = (value, name) => Array.isArray(value) && !value.includes(name);
  const checks = {
    codexMirrored: includes(r.serversAfterCodex, "node_repl"),
    bothSourcesCoexist: includes(r.serversAfterCursor, "node_repl") && includes(r.serversAfterCursor, "cursor-fixture"),
    disableRetractsOnlyCodex: excludes(r.serversAfterDisable, "node_repl") && includes(r.serversAfterDisable, "cursor-fixture"),
    reenablePreservesCursor: includes(r.serversAfterReenable, "node_repl") && includes(r.serversAfterReenable, "cursor-fixture"),
    removeRetractsOnlyCodex: excludes(r.serversAfterRemove, "node_repl") && includes(r.serversAfterRemove, "cursor-fixture"),
    cleanupLeavesMirrorEmpty: Array.isArray(r.serversAfterCleanup) && r.serversAfterCleanup.length === 0
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new Error(`MCP smoke checks failed: ${failedChecks.join(", ")}`);
  }
  r.checks = checks;
  const out = r;
  process.stdout.write("SMOKE_RESULT=" + JSON.stringify(out) + "\n");
  app3.exit(0);
}
main().catch((err) => {
  process.stdout.write("SMOKE_FATAL=" + String(err && err.stack || err) + "\n");
  app3.exit(1);
});
/*! Bundled license information:

smol-toml/dist/date.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/error.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/util.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/primitive.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/extract.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/struct.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/parse.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/stringify.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)

smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
