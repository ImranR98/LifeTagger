// Functions to parse and validate environment variables/
// Always run prepEnv() before anything else, and update that function when/if environment variable needs change

const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '..', 'app.env') })
const helpers = require('./helpers')

/** Check that the specified directory exists (if not, optionally create it) and return the path; throws an error if the dir was not found/created */
module.exports.ensureDir = (path, createIfNotFound = false) => {
    if (!fs.existsSync(path)) {
        if (!createIfNotFound) throw new Error(`'${path}' does not exist`)
        else fs.mkdirSync(path)
    } else if (!fs.statSync(path).isDirectory())
        throw new Error(`'${path}' is not a directory`)
    return path
}
/** Converts the provided string into a positive (> 0) integer; throws an error if the string does not fully contain an int ('12AB' is only a partial int) */
module.exports.strToPosInt = (str) => {
    if (Number.isNaN(str))
        throw new Error(`'${str}' is not a number`)
    else {
        const result = Number.parseInt(str)
        if (result <= 0) throw new Error(`'${str}' is not a positive integer`)
        return result
    }
}
/** Returns a boolean value if the provided string is 'true', 'false', or empty (case insensitive); else throws an error  */
module.exports.strToBool = (str) => {
    const s = str.toLowerCase().trim()
    const trueFalseEmptyRegex = /(^$|^(t|T)(r|R)(u|U)(e|E)$|^(f|F)(a|A)(l|L)(s|S)(e|E)$)/
    if (!trueFalseEmptyRegex.test(s)) throw new Error(`'${str}' is neither 'true' nor 'false' nor empty`)
    else return s === 'true'
}

/** Validate the required evironment variable strings (as defined/hardcoded in this function) and replace them with parsed versions */
module.exports.prepEnv = () => {
    const requiredVars = {
        paths: {
            vars: ['MEDIA_FOLDER_PATH'],
            parseFunc: this.ensureDir
        },
        posInts: {
            vars: [],
            parseFunc: this.strToPosInt
        },
        bools: {
            vars: [],
            parseFunc: this.strToBool
        },
        arrays: {
            vars: ['EXCLUDE_EXT'],
            parseFunc: helpers.commaSeparatedStringToArray
        }
    }
    Object.keys(requiredVars).forEach(key => {
        for (let i = 0; i < requiredVars[key].vars.length; i++) {
            if (typeof process.env[requiredVars[key].vars[i]] !== 'string') throw new Error(`Environment variable '${requiredVars[key].vars[i]}' does not exist`)
            else process.env[requiredVars[key].vars[i]] = requiredVars[key].parseFunc(process.env[requiredVars[key].vars[i]])
        }
    })
}