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
            if (this.taggedTestRegEx.test(file)) return false
            for (let i = 0; i < excludeExtensions.length; i++) {
                if (file.toLowerCase().endsWith(`.${excludeExtensions[i].toLowerCase()}`)) return false
            }
            return true
        }
    )
    return { targetFiles: helpers.getUpToNumRandomElements(possibleTargets, batchSize), allTargetsCount: possibleTargets.length }
}

/** Get the EXIF tags and description for the proivided file */
module.exports.getFileInfo = async (mediaDir, file, desc = true) => {
    let existingTagString = this.taggedTestRegEx.exec(file)
    let existingTags = existingTagString ? existingTagString[0].slice(2, existingTagString[0].lastIndexOf(']')).split(',').map(tag => tag.trim()) : []
    let res = { file, existingTags }
    if (desc) res['description'] = await helpers.readFileDescription(`${mediaDir}/${file}`)
    return res
}

/** Gets a list of all files in the provided path, along with each file's existing tags (if any) */
module.exports.getFileList = async (mediaDir, excludeExtensions) => {
    let allTargets = helpers.filterFiles(mediaDir, (file) => {
        for (let i = 0; i < excludeExtensions.length; i++) {
            if (file.toLowerCase().endsWith(`.${excludeExtensions[i].toLowerCase()}`)) return false
        }
        return true
    })
    let ans = []
    for (let i = 0; i < allTargets.length; i++) {
        ans.push(await this.getFileInfo(mediaDir, allTargets[i], false))
    }
    return { files: ans }
}

/** Gets an array of currently used tags for all target files in the provided path */
module.exports.getPrevUsedTags = async (mediaDir, excludeExtensions) => {
    let tags = []
    let fl = await this.getFileList(mediaDir, excludeExtensions)
    fl.files.forEach(file => {
        tags = tags.concat(file.existingTags)
    })
    return Array.from(new Set(tags))
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

/** Write the provided tags and description to a file's 'Description' EXIF tag, and add the tags to its filename (replacing existing tags if any - unstable)
 * (does not validate the path or tag string - assumes they are valid)
 * Also replaces all '.' with ';' since '.' is used as a separator
*/
module.exports.tagFileEXIF = async (path, tags, description, deleteOriginal = true) => {
    let originalDescription = await helpers.readFileDescription(path)
    if (originalDescription) {
        originalDescription = originalDescription.split('.')
        const existingTagsResult = this.taggedTestRegEx.exec('a-[' + originalDescription[0] + '].bcd')
        if (existingTagsResult) originalDescription = originalDescription.slice(1)
        originalDescription = originalDescription.join('.')
    }
    if (description[description.length - 1] === '.' || description[description.length - 1] === ';') description = description.slice(0, -1)
    await helpers.writeFileDescription(path, `${tags}. ${description.split('.').join(';')}.${originalDescription ? ' ' + originalDescription : ''}`)
    if (deleteOriginal) fs.unlinkSync(`${path}_original`)
}

/** Add the provided tags to a file's name (replacing existing tags if any)
 * (does not validate the path or tag string - assumes they are valid)
*/
module.exports.tagFileName = (path, tags) => {
    const newPath = helpers.parsePath(path)
    const existingTagResult = this.taggedTestRegEx.exec(`${newPath.fileName}.${newPath.fileExt}`)
    fs.renameSync(path, `${newPath.dirPath}/${existingTagResult ? newPath.fileName.slice(0, existingTagResult['index']) : newPath.fileName}-[${tags}].${newPath.fileExt}`)
}