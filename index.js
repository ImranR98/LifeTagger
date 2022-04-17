const prepEnv = require('./lib/prepEnv')
const funcs = require('./lib/funcs')
const express = require('express')

const app = express()
app.use(express.json())

app.get('/api/files', async (req, res) => {
    try {
        res.send(await funcs.getFileList(process.env['MEDIA_FOLDER_PATH'], process.env['EXCLUDE_EXT']))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/file/:name/content', async (req, res) => {
    try {
        res.sendFile(`${process.env['MEDIA_FOLDER_PATH']}/${req.params.name}`)
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/file/:name', async (req, res) => {
    try {
        res.send(await funcs.getFileInfo(process.env['MEDIA_FOLDER_PATH'], req.params.name))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.post('/api/file/:name', async (req, res) => {
    try {
        await funcs.tagFileEXIF(`${process.env['MEDIA_FOLDER_PATH']}/${req.params.name}`, req.body.tags.join(', '), req.body.description || '')
        await funcs.tagFileName(`${process.env['MEDIA_FOLDER_PATH']}/${req.params.name}`, req.body.tags.join(', '))
        res.send()
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.get('/api/tags', async (req, res) => {
    try {
        res.send(await funcs.getPrevUsedTags(process.env['MEDIA_FOLDER_PATH'], process.env['EXCLUDE_EXT']))
    } catch (err) {
        console.error(err)
        res.status(500).send(err)
    }
})

app.all('/api/*', (req, res) => {
    res.status(404).send()
})

async function main() {
    prepEnv.prepEnv()
    app.listen(process.env.PORT || 8080, () => {
        console.log(`Server listening on port ${process.env.PORT || 8080}`)
    })
}

main().catch(err => console.error(err))