/*
TODO:
1. Grab array of all files in the directory, filter out already tagged ones (those that follow the -[tag1, tag2, tag3].ext format)
2. From the remaining array, pick X number of files at random (forget the rest)
3. For each remaining file...
    1. Open the file in the appropriate default program (image viewer or media player) - not sure how to do this yet
        - Especially see if it can be opened in an unfocused window to the side, so the terminal remains in focus (or open a preview inside the terminal?)
    2. Check if a tags.txt exists in the directory and if so, show its contents (preferably in a new window while also keeping terminal in focus)
    3. Ask the user to type in tags and make sure it is a comma separated string with letters and numbers only (also trim each tag and make it all lowercase)
    4. Save the users validated tags by appending to the filename in the appropriate format and adding to the exiftool `Description` tag
        - If the exiftool addition was not possible, warn the user (this is not an error, just an FYI as filename should be enough)
    5. Update tags.txt with any new tags

Notes:
1. Scanning the directory and filtering previously tagged files may be too slow to repeat on each run - may need to think about a solution

Possible future upgrades:
1. A GUI to allow for built in file previews and tag autocomplete
2. A server version of this that can be hosted by a user, then accessed any time from their phone or PC; also giving them daily notification reminders
*/

// Before anything else, prepare the environment variables
require('./prepEnv').prepEnv()

const open = require('open')
const { exiftool } = require('exiftool-vendored')