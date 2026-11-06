# Installing webOS IPTV Player on an LG TV

This guide installs the app from
[pedjasa-spec/webos-iptv-player](https://github.com/pedjasa-spec/webos-iptv-player/tree/custom-organization)
on an LG TV with webOS. After the first setup, you install, update, and
keep the app using only the TV and its remote.

## Read this first

LG only lets you install apps from outside its store through a feature
called **Developer Mode**. It works, with one catch:

- **A Developer Mode session lasts about 41 days (1000 hours).** If it runs
  out, the TV **removes this app and Homebrew Channel, together with all
  your settings, playlists, and favorites.** To get them back, someone has
  to repeat the one-time setup below.
- **You can extend the session from the TV with the remote, as many times
  as you like.** Do it once a month and nothing is lost. See
  [Keeping the app](#keeping-the-app-once-a-month).

## What you need

- An LG TV with webOS, connected to the internet.
- For the **one-time setup**, a helper with an **Android phone** or a
  **computer** (Windows, Mac, or Linux), on the same Wi-Fi network as the
  TV. This takes about 20 minutes. Everything after that is done with the
  remote.

## Part 1: One-time setup (with a helper)

### 1. Create a free LG developer account

On a phone or computer, go to
[webostv.developer.lge.com](https://webostv.developer.lge.com), choose
**Sign In**, and create an account. Write down the email and password.

### 2. Turn on Developer Mode on the TV

1. On the TV, open the **LG Content Store** (or **Apps**), search for
   **Developer Mode**, and install it.
2. Open **Developer Mode** and sign in with the account from step 1.
3. Turn **Dev Mode Status** on. The TV restarts.
4. Open **Developer Mode** again and turn **Key Server** on.
5. Leave this screen open. It shows the TV's **IP address**, and a
   six-character **Passphrase** at the bottom left. The helper needs both
   in the next step.

### 3. Install Homebrew Channel

Homebrew Channel is a free app store for apps that are not in LG's store.
Use **one** of these two ways.

**With an Android phone**

1. Install **webOS Dev Manager** from
   [Google Play](https://play.google.com/store/apps/details?id=org.webosbrew.devman).
2. Open it and add a device. Enter the TV's **IP address**, choose
   **Dev Mode** as the authentication, and type the **passphrase** shown
   on the TV.
3. Open the list of available apps, find **Homebrew Channel**, and
   install it.

**With a computer**

1. Download **webOS Dev Manager** for your system from its
   [releases page](https://github.com/webosbrew/dev-manager-desktop/releases/latest).
2. Follow the same three steps as with the phone: add the TV with its IP
   address, **Dev Mode**, and the passphrase, then install
   **Homebrew Channel** from the list of available apps.

There is no iPhone version of webOS Dev Manager. With an iPhone, use a
computer.

The helper's part is done. The TV no longer needs the phone or computer.

## Part 2: Install the app (with the remote)

### 4. Add this app's repository

1. On the TV, open **Homebrew Channel**.
2. Select the **gear** icon at the top to open **Settings**.
3. Scroll down to **Repositories** and select **Add repository**.
4. Type this address exactly, then select **Add repository**:

   ```
   https://pedjasa-spec.github.io/webos-iptv-player/repo.json
   ```

Check it letter by letter before you confirm. If Homebrew Channel says
*"An error occured while downloading repository"*, the address has a
typo.

If the address above is typed correctly and still fails, use this longer
one instead. It points to the same app:

```
https://raw.githubusercontent.com/pedjasa-spec/webos-iptv-player/custom-organization/homebrew-repository.json
```

### 5. Install the app

1. Go back to the main **Homebrew Channel** screen.
2. Select **webOS IPTV Player**. Its description starts with
   *"This is a fork of lennylxx/webos-iptv-player"*.
3. Select **Install**, wait for it to finish, then select **Launch**.

The app also appears in the TV's normal app list.

## Keeping the app (once a month)

1. Open the **Developer Mode** app on the TV.
2. Check the time left in the **Remain Session** field.
3. Select **EXTEND** to reset it to the full 1000 hours. The TV must be
   connected to the internet.

Pick a fixed day, for example the first day of each month, and do it
then. It takes under a minute.

**Keep a backup of your settings.** In the app, open
**Settings > Data Management > Backup > Export Settings** and scan the QR
code with your phone. It saves a file with your playlists, accounts,
folders, and favorites. If the session ever runs out, restore it with
**Import Settings** after reinstalling, instead of setting everything up
again.

## Updating the app

When a new version is out, Homebrew Channel shows it on the
**webOS IPTV Player** page. Select the button to update.

After an update, the TV may keep showing the old version until the app
is fully closed. If nothing seems to have changed, restart the TV.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The app and Homebrew Channel are gone from the TV | The Developer Mode session ran out. Repeat Part 1 and Part 2, then restore your settings backup. |
| *"An error occured while downloading repository"* | The repository address has a typo. Remove it in **Settings > Repositories** and add it again. If it still fails, use the longer address from step 4. |
| webOS Dev Manager cannot connect to the TV | Make sure the phone or computer is on the same Wi-Fi as the TV, **Key Server** is on in the Developer Mode app, and the passphrase is typed exactly as shown. |
| The app does not appear in Homebrew Channel | Select the refresh icon at the top of Homebrew Channel, and check the repository address in **Settings**. |
