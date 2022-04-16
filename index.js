const prepEnv = require('./lib/prepEnv')
const funcs = require('./lib/funcs')
const express = require('express')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(express.json())

app.get('/files', async (req, res) => {
    try {
        res.send(funcs.getFileList(process.env.MEDIA_FOLDER_PATH))
    } catch (err) {
        res.status(500).send(err)
    }
})

app.get('/file/:name/content', async (req, res) => {
    try {
        res.sendFile(fs.readFileSync(`${process.env.MEDIA_FOLDER_PATH}/${req.params.name}`))
    } catch (err) {
        res.status(500).send(err)
    }
})

async function main() {
    prepEnv.prepEnv()
    app.listen(process.env.PORT || 8080, () => {
        console.log(`Server listening on port ${process.env.PORT || 8080}`)
    })
}

main().catch(err => console.error(err))