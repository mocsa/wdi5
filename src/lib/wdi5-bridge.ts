import { resolve } from "path"
import { writeFile } from "fs/promises"
import { tmpdir } from "os"

import { wdi5Config, wdi5Selector } from "../types/wdi5.types"
import { WDI5 } from "./WDI5"
import { clientSide_injectUI5 } from "../../client-side-js/injectUI5"
import { clientSide_getSelectorForElement } from "../../client-side-js/getSelectorForElement"
import { clientSide__checkforUI5Ready } from "../../client-side-js/_checkforUI5Ready"

import { Logger as _Logger } from "./Logger"
const Logger = _Logger.getInstance()

/** @type {Boolean} store the status of initialization */
let _isInitialized = false
/** @type {Boolean} stores the status of the setup process */
let _setupComplete = false
/** @type {String} currently running sap.ui.version */
let _sapUI5Version = null
/** relay runtime config options from Service */
let _config: wdi5Config = null

export async function setup(config: wdi5Config) {
    _config = config
    if (_setupComplete) {
        // already setup done
        return
    }
    // jump-start the desired log level
    Logger.setLogLevel(config.wdi5.logLevel)

    // init control cache
    if (!browser._controls) {
        Logger.info("creating internal control map")
        browser._controls = []
    }

    addWdi5Commands()

    _setupComplete = true
}

export async function start(config: wdi5Config) {
    // TODO: document that we require wdio.config.baseUrl with a trailing slash à la "http://localhost:8080/"
    if (config.wdi5.url !== "") {
        Logger.info(`open url: ${config.wdi5.url}`)
        await browser.url(config.wdi5.url)
    } else {
        Logger.info("open url with fallback '#' (this is not causing any issues since its is removed for navigation)")
        await browser.url("#")
    }
}

/**
 * function library to setup the webdriver to UI5 bridge, it runs alle the initial setup
 * make sap/ui/test/RecordReplay accessible via wdio
 * attach the sap/ui/test/RecordReplay object to the application context window object as 'bridge'
 */
export async function injectUI5(config: wdi5Config) {
    const waitForUI5Timeout = config.wdi5.waitForUI5Timeout || 15000
    // expect boolean
    const result = await clientSide_injectUI5(config, waitForUI5Timeout)

    if (result) {
        // set when call returns
        _isInitialized = true
        Logger.success("sucessfully initialized wdio-ui5 bridge")
    } else {
        Logger.error("bridge was not initialized correctly")
    }
    return result
}

//******************************************************************************************

/**
 * creates a string valid as object key from a selector
 * @param selector
 * @returns wdio_ui5_key
 */
function _createWdioUI5KeyFromSelector(selector: wdi5Selector): string {
    const orEmpty = (string) => string || "-"

    const _selector = selector.selector
    const wdi5_ui5_key = `${orEmpty(_selector.id)}_${orEmpty(_selector.viewName)}_${orEmpty(
        _selector.controlType
    )}_${orEmpty(JSON.stringify(_selector.bindingPath))}_${orEmpty(JSON.stringify(_selector.I18NText))}_${orEmpty(
        _selector.labelFor
    )}_${orEmpty(JSON.stringify(_selector.properties))}`.replace(/[^0-9a-zA-Z]+/, "")

    return wdi5_ui5_key
}

export async function addWdi5Commands() {
    browser.addCommand("asControl", async (wdi5Selector: wdi5Selector) => {
        const internalKey = wdi5Selector.wdio_ui5_key || _createWdioUI5KeyFromSelector(wdi5Selector)
        // either retrieve and cache a UI5 control
        // or return a cached version
        if (!browser._controls?.[internalKey] || wdi5Selector.forceSelect /* always retrieve control */) {
            Logger.info(`creating internal control with id ${internalKey}`)
            wdi5Selector.wdio_ui5_key = internalKey
            const wdi5Control = new WDI5().init(wdi5Selector, wdi5Selector.forceSelect)
            browser._controls[internalKey] = wdi5Control
        } else {
            Logger.info(`reusing internal control with id ${internalKey}`)
        }
        return browser._controls[internalKey]
    })

    /**
     * Find the best control selector for a DOM element. A selector uniquely represents a single element.
     * The 'best' selector is the one with which it is most likely to uniquely identify a control with the least possible inspection of the control tree.
     * @param {object} oOptions
     * @param {object} oOptions.domElement - DOM Element to search for
     * @param {object} oOptions.settings - ui5 settings object
     * @param {boolean} oOptions.settings.preferViewId
     */
    browser.addCommand("getSelectorForElement", async (oOptions) => {
        const result = await clientSide_getSelectorForElement(oOptions)

        if (Array.isArray(result)) {
            if (result[0] === "error") {
                console.error("ERROR: getSelectorForElement() failed because of: " + result[1])
                return result[1]
            } else if (result[0] === "success") {
                console.log(`SUCCESS: getSelectorForElement() returned:  ${JSON.stringify(result[0])}`)
                return result[1]
            }
        } else {
            // Guess: was directly returned
            return result
        }
    })

    /**
     * retieve the sap.ui.version form app under test and saves to _sapUI5Version
     * returns the sap.ui.version string of the application under test
     */
    browser.addCommand("getUI5Version", async () => {
        if (!_sapUI5Version) {
            const resultVersion = await browser.executeAsync((done) => {
                done(sap.ui.version)
            })
            _sapUI5Version = resultVersion
        }

        return _sapUI5Version
    })

    /**
     * returns the sap.ui.version float number of the application under test
     */
    browser.addCommand("getUI5VersionAsFloat", async () => {
        if (!_sapUI5Version) {
            // implicit setter for _sapUI5Version
            await browser.getUI5Version()
        }

        return parseFloat(_sapUI5Version)
    })

    /**
     * uses the UI5 native waitForUI5 function to wait for all promises to be settled
     */
    browser.addCommand("waitForUI5", async () => {
        return await _waitForUI5()
    })

    /**
     * wait for ui5 and take a screenshot
     */
    browser.addCommand("screenshot", async (fileAppendix) => {
        await _waitForUI5()
        await _writeScreenshot(fileAppendix)
    })
}

/**
 * can be called to make sure before you access any eg. DOM Node the ui5 framework is done loading
 * @returns {Boolean} if the UI5 page is fully loaded and ready to interact.
 */
async function _waitForUI5() {
    if (_isInitialized) {
        // injectUI5 was already called and was successful attached
        return await _checkForUI5Ready()
    } else {
        if (await injectUI5(_config)) {
            return await _checkForUI5Ready()
        } else {
            return false
        }
    }
}

/**
 * check for UI5 via the RecordReplay.waitForUI5 method
 */
async function _checkForUI5Ready() {
    if (_isInitialized) {
        // can only be executed when RecordReplay is attached
        return await _checkForUI5Ready()
    }
    return false
}

/**
 * @param fileAppendix
 */
async function _writeScreenshot(fileAppendix = "-screenshot") {
    // if config param screenshotsDisabled is set to true -> no screenshots will be taken
    if (_config.wdi5["screenshotsDisabled"]) {
        Logger.warn("screenshot skipped due to config parameter")
        return
    }

    // browser.screenshot returns the screenshot as a base64 string
    const screenshot = await browser.takeScreenshot()
    const seed = _getDateString()

    const _path = _config.wdi5.screenshotPath || tmpdir()
    const path = resolve(_path, `${seed}-${fileAppendix}.png`)

    try {
        await writeFile(path, screenshot, "base64")
        Logger.success(`screenshot at ${path} created`)
    } catch (error) {
        Logger.error(error)
    }
}

/**
 * generates date string with format M-d-hh-mm-ss
 * @returns {String}
 */
function _getDateString() {
    var x = new Date()
    return `${x.getMonth() + 1}-${x.getDate()}-${x.getHours()}-${x.getMinutes()}-${x.getSeconds()}`
}
