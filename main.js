// Main LifeTagger CLI process

const open = require('open')
const helpers = require('./lib/helpers')
const funcs = require('./lib/funcs')

/** Main function */
const main = async (mediaDir, batchSize, excludeExtensions) => {
    const tagsFilePath = `${mediaDir}/tags.txt`
    // Grab array of all files in the directory, filter out already tagged ones and pick X number of files at random
    const { targetFiles, allTargetsCount } = funcs.getTargetFiles(mediaDir, batchSize, excludeExtensions)
    if (targetFiles.length === 0) {
        console.log(`All Done! No untagged files remain in '${mediaDir}'`)
        return
    }
    let skipped = 0
    loop: for (let i = 0; i < targetFiles.length; i++) { // For each target file...
        console.log('\n\n')
        let targetFilePath = `${mediaDir}/${targetFiles[i]}`
        const filePromise = open(targetFilePath, { wait: true }) // Open the file in the appropriate default program
        console.log('Opened file: ' + targetFiles[i])
        const prevUsedTags = funcs.getPrevUsedTags(mediaDir, excludeExtensions)
        console.log(`Previously used tags list: ${prevUsedTags.join(', ')}`) // Show previously used tags from a stored list file
        const tags = await funcs.askForTags() // Ask the user to type in tags
        if (tags === null) { // Skip this file if the user wants to
            console.warn(`You have skipped '${targetFiles[i]}' this time`)
            skipped++
            continue loop
        }
        const description = await helpers.getInput('Enter a description (no periods, can be empty): ') || '' // Ask the user to type in a plain text description
        console.log('Close the file to begin applying changes.')
        await filePromise
        console.log('Applying EXIF changes...')
        try { // Use exiftool to update the file's description tag with the user's input
            await funcs.tagFileEXIF(targetFilePath, tags, description)
        } catch (err) { // If that failed, the user can skip this file or just ignore the error and go ahead with adding tags to the filename
            console.error(err)
            if (!await helpers.askYesNo('Above error was encountered. Do you still want to add the tags to filename?')) {
                console.warn(`You have skipped '${targetFiles[i]}' this time`)
                skipped++
                continue loop
            }
        }
        funcs.tagFileName(targetFilePath, tags) // Add the tag string to the filename
    }
    console.log(`\n\nDone for now!
    Come back soon to continue tagging the ${allTargetsCount - batchSize + skipped} remaining files.`)
}

require('./lib/prepEnv').prepEnv()
main(process.env['MEDIA_FOLDER_PATH'], process.env['BATCH_SIZE'], process.env['EXCLUDE_EXT']).catch((err) => {
    console.error(err)
    process.exit(1)
})

/*
Possible future upgrades:
1. A GUI to allow for built in file previews and tag autocomplete
2. A server version that exposes an API to get targets and update them; extend the above GUI to act as the client (maybe add daily notification reminders)
*/