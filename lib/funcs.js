// Functions that perform most of what LifeTagger does
// Meant to be re-usable between the CLI version and a possible GUI version

const helpers = require('./helpers')
const fs = require('fs')

module.exports.taggedTestRegEx = /-\[( *([a-zA-Z0-9]|-|_)+,)* *([a-zA-Z0-9]|-|_)+ *\]\.[a-zA-Z0-9]+$/

/** Gets a specific number random untgged files from the provided path, and return their names as well as the total number of untagged files */
module.exports.getTargetFiles = (mediaDir, batchSize, excludeExtensions) => {
    const possibleTargets = helpers.filterFiles(
        mediaDir,
        (file) => {
            console.log(file)
            if (this.taggedTestRegEx.test(file)) return false
            for (let i = 0; i < excludeExtensions.length; i++) {
                if (file.toLowerCase().endsWith(`.${excludeExtensions[i].toLowerCase()}`)) return false
            }
            return true
        }
    )
    return { targetFiles: helpers.getUpToNumRandomElements(possibleTargets, batchSize), allTargetsCount: possibleTargets.length }
}

/** If the provided string is a valid tag string, removed extra whitespace and returns it, else throws an error */
module.exports.parseTagString = (tags) => {
    if (!this.taggedTestRegEx.test(`name-[${tags}].ext`)) throw 'Input is not a valid tag string'
    return tags.split(',').map(tag => tag.trim()).join(', ')
}

/** Asks the user for a list of tags and validates them (asks again if input is invalid; returns null if SIGINT received) */
module.exports.askForTags = async () => {
    while (true) {
        const tags = await helpers.getInput(
            'Enter a comma-separated list of tags (allowed characters: letters, numbers, -, _) or press ctrl+c to skip this file:'
        )
        if (tags === null) {
            return null
        }
        try {
            return this.parseTagString(tags)
        } catch (err) {
            console.error(err)
        }
    }
}

/** Write the provided tags and description to a file's 'Description' EXIF tag, and add the tags to its filename
 * (does not validate the path or tag string - assumes they are valid)
 * Also replaces all '.' with ';' since '.' is used as a separator
*/
module.exports.tagFileEXIF = async (path, tags, description, deleteOriginal = true) => {
    const originalDescription = await helpers.readFileDescription(path)
    if (description[description.length - 1] === '.' || description[description.length - 1] === ';') description = description.slice(0, -1)
    await helpers.writeFileDescription(path, `${tags}. ${description.split('.').join(';')}.${originalDescription ? ' ' + originalDescription : ''}`)
    if (deleteOriginal) fs.unlinkSync(`${path}_original`)
}

/** Add the provided tags to a file's name
 * (does not validate the path or tag string - assumes they are valid)
*/
module.exports.tagFileName = (path, tags) => {
    const newPath = helpers.parsePath(path)
    fs.renameSync(path, `${newPath.dirPath}/${newPath.fileName}-[${tags}].${newPath.fileExt}`)
}

console.log(this.getTargetFiles(`/home/imranr/Pictures/TestDir-Original`, 5, ['pp3', 'txt']))