# LifeTagger
> Add searchable tags to your vast media library, one batch at a time.

It's the 2020s and over the years, you've ammassed a lifetime of photos and videos. Sounds great, but without a way to actually search through it all, your vast library of memories is about as useful as [Write-Only Memory](https://en.wikipedia.org/wiki/Write-only_memory_(joke)). You could, of course, rely on a service like Google Photos that uses machine-learning magic to tag items for you, but this method is far from perfect and - more importantly - relies on a shady for-profit company which produces non-portable results that will lock you in to their platform.

No, the only solution is to quit your job, retreat to an isolated mountain, and spend the next few months combing through each file and tagging it manually. Or you could use LifeTagger.

LifeTagger breaks the task out into manageable chunks. Point it to your media folder and it will present a list of all media files in a Web-based GUI; all you need to do is type in the appropriate tags (or pick from a list of previously used ones) and LifeTagger will write those to the file name and the EXIF 'Description' field (a plain text description can also be added to the EXIF data). The idea is to do this a few files at a time and turn this into a daily habit that, while only taking up a minute of your time a day, will - in a few years - result in a media library that will be fully searchable for life - no matter what storage medium or cloud platform you save them to.

## Setup
0. Install [Node.js](https://nodejs.org/en/) on your PC.
1. Copy the `template.env` file and rename the copy to `app.env`.
2. Fill `app.env` in with appropriate information as described in that file (replace the descriptions after the `=` with your actual info).
3. Build the client by running `npm run build` in a terminal (opened in the LifeTagger folder).
4. Start the server by running `npm start`.
5. Launch your browser and open `http://localhost:8080` and tag a few files, one at a time.
6. Stop the server by pressing `Ctrl-C` in the terminal.
6. Repeat steps 4-6 at least once per day - set a reminder on your phone, a sticky note on your fridge, or hire someone to remind you by knocking on your window every morning idk.

## More Details
- Tags are appended to the file name in the following format: `filename-[tag1, tag2, tag3].jpeg`.
    - ***Note: Any file that already follows the above format (ends with square brackets containing comma separated string) will be assumed to have been tagged already and will, as such, be skipped.*** 
- It may not always be possible to write data to a file's `Description` EXIF tag; for these you may only be able to add tags to the file name.
