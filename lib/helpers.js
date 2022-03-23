// Re-usable helper functions that are generic enough that they could be used in other projects - nothing too LifeTagger specific here

const fs = require('fs')
const readLine = require('readline')
const { exiftool } = require('exiftool-vendored')

/** Send a prompt message to stdout and get a line of user input from stdin */
module.exports.getInput = (prompt = 'Input Answer:') => new Promise((resolve, reject) => {
    const rl = readLine.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => {
        rl.close()
        resolve(null)
    }).question(prompt + '\n', ans => {
        rl.close()
        resolve(ans)
    })
})

/** Send a prompt message to stdout and return a boolean when the user enters Y or N (case insensitive) - keep asking if input is incorrect */
module.exports.askYesNo = async (prompt = 'Input Answer:') => {
    let answer = null
    while (answer !== 'y' && answer !== 'n') answer = (await this.getInput(prompt) || '').trim().toLowerCase()
    return answer === 'y'
}

/** Scan a directory and return all non-subdirectory filenames that pass the given filter function */
module.exports.filterFiles = (directory, filterFn) =>
    fs.readdirSync(directory).filter(file => !fs.statSync(`${directory}/${file}`).isDirectory() && filterFn(file))

/** Get a number of random elements from an array (if array length is less than the specified number, the whole array is returned) */
module.exports.getUpToNumRandomElements = (arr, num) => {
    if (arr.length < num) return arr
    let indices = new Set()
    while (indices.size < num)
        indices.add(Math.floor(Math.random() * arr.length))
    const result = []
    indices.forEach((index) => result.push(arr[index]))
    return result
}

/** Reads a comma separated string and returns an array of the contents */
module.exports.commaSeparatedStringToArray = (string) => string.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)

/** Reads a comma separated string from the first line of a file (that is assumed to be valid) and returns an array of the contents (empty if no file) */
module.exports.readCommaSeparatedArrayFromFile = (path) => {
    if (!fs.existsSync(path) || fs.statSync(path).isDirectory()) return []
    return this.commaSeparatedStringToArray(fs.readFileSync(path).toString().split('\n')[0])
}

/** Writes the contents of an array (assumed to be of strings containing no commas) as a comma separated string into a file (creates/overwites if needed)*/
module.exports.writeCommaSeparatedArrayToFile = (path, arr) => {
    let final = ''
    for (let i = 0; i < arr.length; i++) final += arr[i] + (i === arr.length - 1 ? '' : ', ')
    fs.writeFileSync(path, final)
}

/** Merge two arrays, removing duplicates */
module.exports.mergeArrays = (arr1, arr2) => Array.from(new Set([...arr1, ...arr2]))

/** Parses a file path and returns an object containing the path to the containing directory, the file name w/o extension, and the file extension
 * (only does text manipulation; does not validate the given path string)
 */
module.exports.parsePath = (path) => {
    let temp1 = path.split('/')
    let temp2 = temp1.pop().split('.')
    return {
        dirPath: temp1.join('/'),
        fileExt: temp2.pop(),
        fileName: temp2.join('.')
    }
}

/** Uses Exiftool to return the text in a file's 'Description' metadata tag  */
module.exports.readFileDescription = (path) => new Promise((resolve, reject) => {
    exiftool.read(path)
        .then((tags) => resolve(tags.Description))
        .catch((err) => reject(err))
})

/** Uses Exiftool to write text to a file's 'Description' metadata tag  */
module.exports.writeFileDescription = (path, text) => new Promise((resolve, reject) => {
    exiftool.write(path, { Description: text })
        .then((tags) => resolve())
        .catch((err) => reject(err))
})