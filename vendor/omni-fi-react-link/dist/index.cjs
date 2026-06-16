"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  OMNIFI_EVENTS: () => OMNIFI_EVENTS,
  getScriptUrl: () => getScriptUrl,
  useOmniFILink: () => useOmniFILink
});
module.exports = __toCommonJS(index_exports);

// src/useOmniFILink.ts
var import_react = require("react");

// src/types.ts
var OMNIFI_EVENTS = {
  SUCCESS: "omni-fi:success",
  ERROR: "omni-fi:error",
  EXIT: "omni-fi:exit",
  READY: "omni-fi:ready",
  SET_THEME: "omni-fi:set-theme",
  SET_LANGUAGE: "omni-fi:set-language",
  CONNECTION_LINKED: "omni-fi:connection-linked"
};

// src/lib/scriptUrl.ts
var PRODUCTION_SCRIPT_URL = "https://cdn.omni-fi.co/v1/omni-fi-connect.js";
var STAGING_SCRIPT_URL = "https://staging-cdn.omni-fi.co/v1/omni-fi-connect.js";
var DEVELOPMENT_SCRIPT_URL = "http://localhost:5173/omni-fi-connect.js";
var getScriptUrl = (env = "production") => {
  switch (env) {
    case "development":
      return DEVELOPMENT_SCRIPT_URL;
    case "staging":
      return STAGING_SCRIPT_URL;
    case "production":
    default:
      return PRODUCTION_SCRIPT_URL;
  }
};
var getLoaderEnvironment = (env = "production") => {
  switch (env) {
    case "development":
      return "local";
    case "staging":
      return "staging";
    case "production":
    default:
      return "production";
  }
};

// src/useOmniFILink.ts
function useOmniFILink(config) {
  const [isReady, setIsReady] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const configRef = (0, import_react.useRef)(config);
  const instanceRef = (0, import_react.useRef)(null);
  const loaderEnvRef = (0, import_react.useRef)(
    null
  );
  (0, import_react.useEffect)(() => {
    if (loaderEnvRef.current !== null && configRef.current.env !== config.env) {
      console.warn(
        `[omni-fi/react-link] OmniFIConfig.env changed after mount (`,
        configRef.current.env,
        "\u2192",
        config.env,
        "). The change is ignored \u2014 the loader script URL was locked at first mount. Set env once at mount time; mount the hook on a new key if you need to switch environments at runtime."
      );
    }
    configRef.current = config;
  }, [config]);
  (0, import_react.useEffect)(() => {
    const scriptUrl = configRef.current.scriptUrl ?? getScriptUrl(configRef.current.env);
    loaderEnvRef.current = getLoaderEnvironment(configRef.current.env);
    if (window.OmniFI) {
      setIsReady(true);
      return () => {
        instanceRef.current?.destroy();
      };
    }
    const handleLoad = () => setIsReady(true);
    const handleError = (event) => setError(
      new Error(
        `Failed to load Omni-FI SDK script from ${scriptUrl}${event.type ? ` (event: ${event.type})` : ""}`
      )
    );
    let script = document.querySelector(
      `script[src="${scriptUrl}"]`
    );
    if (!script) {
      script = document.createElement("script");
      script.src = scriptUrl;
      script.async = true;
      script.addEventListener("load", handleLoad);
      script.addEventListener("error", handleError);
      document.head.appendChild(script);
    } else {
      script.addEventListener("load", handleLoad);
      script.addEventListener("error", handleError);
    }
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      instanceRef.current?.destroy();
    };
  }, []);
  const destroy = (0, import_react.useCallback)(() => {
    instanceRef.current?.destroy();
    instanceRef.current = null;
  }, []);
  const open = (0, import_react.useCallback)(() => {
    if (!window.OmniFI) {
      throw new Error(
        "[OmniFI] open() called before the SDK is ready. Wait for isReady to be true before calling open()."
      );
    }
    instanceRef.current?.destroy();
    instanceRef.current = window.OmniFI.connect({
      ...configRef.current,
      environment: loaderEnvRef.current ?? "production"
    });
  }, []);
  const setTheme = (0, import_react.useCallback)((theme) => {
    instanceRef.current?.setTheme(theme);
  }, []);
  const setLanguage = (0, import_react.useCallback)((lang) => {
    instanceRef.current?.setLanguage(lang);
  }, []);
  return { open, destroy, isReady, error, setTheme, setLanguage };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OMNIFI_EVENTS,
  getScriptUrl,
  useOmniFILink
});
