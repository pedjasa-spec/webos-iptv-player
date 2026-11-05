#!/usr/bin/env node

import { createHash } from 'crypto';
import { basename, resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const packageInfo = JSON.parse(readFileSync('package.json', 'utf8'));
const appInfo = JSON.parse(readFileSync('appinfo.json', 'utf8'));

if (appInfo.version !== packageInfo.version) {
  throw new Error(
    `Version mismatch: package.json is ${packageInfo.version}, appinfo.json is ${appInfo.version}`,
  );
}

// GitHub Actions sets GITHUB_REPOSITORY, so a fork's release points at itself.
const repo = process.env.GITHUB_REPOSITORY || 'lennylxx/webos-iptv-player';

const expectedIpk = `${appInfo.id}_${packageInfo.version}_all.ipk`;
const ipkPath = resolve(process.argv[2] || expectedIpk);
const outputPath = resolve(process.argv[3] || `${appInfo.id}.manifest.json`);

if (basename(ipkPath) !== expectedIpk) {
  throw new Error(`Expected IPK filename ${expectedIpk}, received ${basename(ipkPath)}`);
}

const ipkHash = createHash('sha256').update(readFileSync(ipkPath)).digest('hex');

const manifest = {
  id: appInfo.id,
  version: packageInfo.version,
  type: appInfo.type,
  title: appInfo.title,
  appDescription: appInfo.appDescription,
  iconUri: `https://raw.githubusercontent.com/${repo}/main/assets/icon130.png`,
  sourceUrl: `https://github.com/${repo}`,
  rootRequired: false,
  ipkUrl: basename(ipkPath),
  ipkHash: {
    sha256: ipkHash,
  },
};

writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated ${basename(outputPath)} for ${basename(ipkPath)}`);
