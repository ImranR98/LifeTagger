/*
TODO: Everything:
- Validate that env. vars. exist and are valid (target directory exists, number is a number, etc.)
- Check if a file has already been tagged (if it follows the -[tag1, tag2, tag3] format)
- Grab ten untagged files (in a random order - explicitly not chronological as this process also acts to remind the user of random memories every day)
- Find a way to open the file in the appropriate default program (image viewer or media player) - this will probably be the toughest part
    - Especially see if it can be opened in an unfocused window to the side, so the terminal remains in focus (or open a preview inside the terminal?)
- Allow the user to type in tags and make sure it is a comma separated string with letters and numbers only
    - Add a `tags.txt` to the target directory and update it when new tags are added
    - Show the user the contents of `tags.txt` as they are typing to remind them of existing tags they may want to re-use
- Save the users validated tags by appending to the filename in the appropriate format and adding to the exiftool `Description` tag
    - If the exiftool addition was not possible, warn the user (this is not an error, just an FYI as filename should be enough)
- Would prefer to scan directory and filter already tagged items on each run, but this may not be performant when working with thousands of files
    - May have to rely on a DB to save some state; hopefully not

Possible future upgrades:
- A GUI to allow for built in file previews and tag autocomplete
- A server version of this that can be hosted by a user, then accessed any time from their phone or PC; also giving them daily notification reminders
*/