const prepEnv = require('./lib/prepEnv')
const funcs = require('./lib/funcs')
const express = require('express')
const path = require('path')

const app = express()
const clientDir = path.resolve(__dirname + '/lt-client/dist/lt-client')

app.use(express.json())
app.use(express.static(clientDir))

const targetFolderPath = process.argv[2] || process.env['MEDIA_FOLDER_PATH']
const excludeCSV = process.argv[3] || process.env['EXCLUDE_EXT']

app.get('/api/files', async (req, res) => {
    try {
        res.send(await funcs.getFileList(targetFolderPath, excludeCSV))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/file/:name/content', async (req, res) => {
    try {
        res.sendFile(`${targetFolderPath}/${req.params.name}`)
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/file/:name', async (req, res) => {
    try {
        res.send(await funcs.getFileInfo(targetFolderPath, req.params.name))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.post('/api/file/:name', async (req, res) => {
    try {
        await funcs.tagFileEXIF(`${targetFolderPath}/${req.params.name}`, req.body.tags.join(', '), req.body.description || '')
        await funcs.tagFileName(`${targetFolderPath}/${req.params.name}`, req.body.tags.join(', '))
        res.send()
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/tags', async (req, res) => {
    try {
        res.send(await funcs.getPrevUsedTags(targetFolderPath, excludeCSV))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.all('/api/*', (req, res) => {
    res.status(404).send()
})

app.get('*', (req, res) => {
    res.sendFile(`${clientDir}/index.html`)
})

async function main() {
    prepEnv.prepEnv()
    app.listen(process.env.PORT || 8080, () => {
        console.log(`Server listening on port ${process.env.PORT || 8080}`)
    })
}

main().catch(err => console.error(err))