# LifeTagger [INCOMPLETE]
> Add searchable tags to your vast media library, one batch at a time.

Its the 2020s and over the years, you've ammassed a lifetime of photos and videos. Sounds great, but without a way to actually search through it all, your vast library of memories is about as useful as [Write-Only Memory](https://en.wikipedia.org/wiki/Write-only_memory_(joke)). You could, of course, rely on a service like Google Photos that uses machine-learning magic to tag items for you, but this method is far from perfect and - more importantly - relies on a shady for-profit company which produces non-portable results that will lock you in to their platform.

No, the only solution is to quit your job, retreat to an isolated mountain, and spend the next few months combing through each file and tagging it manually. Or you could use LifeTagger.

LifeTagger breaks the task out into manageable chunks. Point it to your media folder and it will pick a small batch of files and present them to you; all you need to do is type in the appropriate tags (or pick from a list of previously used ones) and LifeTagger will write those to the file (both file name and EXIF `Description` tag if available). The idea is to turn this into a daily habit that, while only taking up a minute of your time a day, will - in a few years - result in a media library that will be fully searchable for life - no matter what storage medium or cloud platform you save them to.

## Setup
0. Install [Node.js](https://nodejs.org/en/) on your PC.
1. Copy the `template.env` file and rename the copy to `app.env`.
2. Fill `app.env` in with appropriate information as described in that file (replace the descriptions after the `=` with your actual info).
3. Run the script by running `npm start` in a terminal (opened in the LifeTagger folder).
4. Repeat step 3 at least once per day - set a reminder on your phone, a sticky note on your fridge, or hire someone to remind you by knocking on your window every morning idk.

## More Details
- Tags are appended to the file name in the following format: `filename-[tag1, tag2, tag3].jpeg`.
    - ***Note: Any file that already follows the above format (ends with square brackets containing comma separated string) will be assumed to have been tagged already and will, as such, be skipped.*** 
- It may not always be possible to write data to a file's `Description` EXIF tag; adding data to the file name is guaranteed to work and likely to be easier to search through later. The EXIF tag is for redundancy. A warning is shown whenever the EXIF tag cannot be written.