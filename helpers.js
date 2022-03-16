const fs = require('fs')
const readLine = require('readline').createInterface({ input: process.stdin, output: process.stdout })
const open = require('open')
const { exiftool } = require('exiftool-vendored')

/** Send a prompt message to stdout and get a line of user input from stdin */
module.exports.getInput = (prompt = 'Input Answer:') => new Promise((resolve, reject) => {
    readLine.question(prompt + '\n', ans => {
        readLine.close();
        resolve(ans)
    })
})

/** Scan a directory and return all non-subdirectory filenames that pass the given filter function */
module.exports.filterFiles = (directory, filterFn) => fs.readdirSync(directory).filter(file => !fs.statSync(`${directory}/${file}`).isDirectory() && !filterFn(file))

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