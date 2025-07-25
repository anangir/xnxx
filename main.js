const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// ==================== KONFIGURASI ====================
const CONFIG = {
  COOKIE: process.env.COOKIE,
  DELAY: {
    MIN: 3,
    MAX: 5,
    ON_ERROR: 3,
    RETRY: 3
  },
  FILES: {
    USERNAMES: 'usernames.txt',
    USED: 'usernames_used.txt'
  },
  MAX_RETRY: 3,
  API_URL: 'https://addplus.org/api/trpc/users.claimPoints?batch=1'
};

// ==================== UTILITY FUNCTIONS ====================
class FileManager {
  static readList(filename) {
    return fs.existsSync(filename)
      ? fs.readFileSync(filename, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean)
      : [];
  }

  static writeList(filename, list) {
    fs.writeFileSync(filename, list.join('\n'), 'utf-8');
  }

  static markAsUsed(username) {
    const used = new Set(this.readList(CONFIG.FILES.USED));
    if (!used.has(username)) {
      used.add(username);
      this.writeList(CONFIG.FILES.USED, Array.from(used));
    }
  }

  static removeFromList(username) {
    const list = this.readList(CONFIG.FILES.USERNAMES);
    const filtered = list.filter(u => u !== username);
    this.writeList(CONFIG.FILES.USERNAMES, filtered);
  }
}

class DelayManager {
  static getRandomDelay(min = CONFIG.DELAY.MIN, max = CONFIG.DELAY.MAX) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static async wait(seconds) {
    const chalk = await import('chalk').then(m => m.default);
    for (let i = seconds; i >= 0; i--) {
      process.stdout.write(`\r${chalk.cyan(`⏳ Delay ${i}s...`)}`);
      await new Promise(res => setTimeout(res, 1000));
    }
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
  }
}

class Logger {
  static async success(username, claimed, total) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.greenBright(`✅ SUCCESS | @${username} | +${claimed} points | Total: ${total}`));
  }

  static async alreadyClaimed(username) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.yellow(`⚠️ SKIPPED | @${username} | Already claimed`));
  }

  static async userNotFound(username) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.redBright(`❌ REMOVED | @${username} | User not found`));
  }

  static async failed(username) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.red(`🔥 FAILED  | @${username} | Max retries exceeded`));
  }

  static async error(username, message) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.red(`🚨 ERROR   | @${username} | ${message}`));
  }

  static async processing(username, current, total) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.blue(`[${current.toString().padStart(3)}/${total}] 🚀 Processing @${username}`));
  }

  static async skip(username) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.gray(`⏭️ SKIPPED | @${username} | Previously processed`));
  }

  static async header() {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.magenta('='.repeat(60)));
    console.log(chalk.magenta('           ADDPLUS POINT CLAIMER v2.0'));
    console.log(chalk.magenta('='.repeat(60)));
    console.log(chalk.yellow(`Delay: ${CONFIG.DELAY.MIN}-${CONFIG.DELAY.MAX}s | Error: ${CONFIG.DELAY.ON_ERROR}s | Retry: ${CONFIG.DELAY.RETRY}s`));
    console.log(chalk.magenta('='.repeat(60)));
  }

  static async footer(processed, successful, failed, skipped) {
    const chalk = await import('chalk').then(m => m.default);
    console.log(chalk.magenta('='.repeat(60)));
    console.log(chalk.bold(`SUMMARY: ${processed} processed | ${chalk.green(successful)} success | ${chalk.red(failed)} failed | ${chalk.yellow(skipped)} skipped`));
    console.log(chalk.magenta('='.repeat(60)));
  }
}

// ==================== MAIN FUNCTIONS ====================
class PointClaimer {
  static getHeaders(username) {
    return {
      'Content-Type': 'application/json',
      'Trpc-Accept': 'application/json',
      'X-Trpc-Source': 'nextjs-react',
      'Origin': 'https://addplus.org',
      'Referer': `https://addplus.org/boost/${username}`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10)',
      'Cookie': CONFIG.COOKIE
    };
  }

  static getPayload(username) {
    return {
      0: {
        json: { username }
      }
    };
  }

  static async handleSuccessResponse(data, username) {
    const claimed = data.data?.onboarding?.points || 0;
    const total = data.data?.userPoints?.points || 0;
    await Logger.success(username, claimed, total);
    FileManager.markAsUsed(username);
    return 'success';
  }

  static async handleAlreadyClaimedResponse(username) {
    await Logger.alreadyClaimed(username);
    FileManager.markAsUsed(username);
    return 'skipped';
  }

  static async handleError(error, username, attempt) {
    if (!error.response) {
      await Logger.error(username, error.message);
      await DelayManager.wait(CONFIG.DELAY.ON_ERROR);
      return 'failed';
    }

    const err = error.response.data;
    const msg = err?.[0]?.error?.json?.message || '';

    if (msg.toLowerCase().includes('not found')) {
      await Logger.userNotFound(username);
      FileManager.removeFromList(username);
      return 'removed';
    }

    if (msg.toLowerCase().includes('unauthorized')) {
      if (attempt < CONFIG.MAX_RETRY) {
        await DelayManager.wait(CONFIG.DELAY.RETRY);
        return 'retry';
      } else {
        await Logger.failed(username);
        await DelayManager.wait(CONFIG.DELAY.ON_ERROR);
        return 'failed';
      }
    }

    if (msg.toLowerCase().includes('already claimed')) {
      return await this.handleAlreadyClaimedResponse(username);
    }

    await Logger.error(username, 'Unknown error');
    await DelayManager.wait(CONFIG.DELAY.ON_ERROR);
    return 'failed';
  }

  static async claimPoint(username) {
    const headers = this.getHeaders(username);
    const payload = this.getPayload(username);

    for (let attempt = 1; attempt <= CONFIG.MAX_RETRY; attempt++) {
      try {
        const response = await axios.post(CONFIG.API_URL, payload, { headers });
        const data = response.data?.[0]?.result?.data?.json;

        if (data?.success === true) {
          return await this.handleSuccessResponse(data, username);
        }

        const message = data?.message?.toLowerCase() || '';
        if (message.includes('already claimed')) {
          return await this.handleAlreadyClaimedResponse(username);
        }

        await Logger.error(username, 'Unknown response');
        return 'failed';

      } catch (error) {
        const action = await this.handleError(error, username, attempt);
        if (action === 'retry') continue;
        return action;
      }
    }
    return 'failed';
  }
}

// ==================== MAIN EXECUTION ====================
(async () => {
  const chalk = await import('chalk').then(m => m.default);

  await Logger.header();

  const allUsernames = FileManager.readList(CONFIG.FILES.USERNAMES);
  const usedUsernames = new Set(FileManager.readList(CONFIG.FILES.USED));

  if (allUsernames.length === 0) {
    console.log(chalk.red('❌ ERROR: No usernames found in usernames.txt'));
    return;
  }

  let stats = { processed: 0, successful: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < allUsernames.length; i++) {
    const username = allUsernames[i];
    await Logger.processing(username, i + 1, allUsernames.length);

    if (usedUsernames.has(username)) {
      await Logger.skip(username);
      stats.skipped++;
      continue;
    }

    const result = await PointClaimer.claimPoint(username);
    stats.processed++;

    if (result === 'success') stats.successful++;
    else if (result === 'failed') stats.failed++;
    else if (result === 'skipped') stats.skipped++;

    if (i < allUsernames.length - 1) {
      const delay = DelayManager.getRandomDelay();
      await DelayManager.wait(delay);
    }
  }

  await Logger.footer(stats.processed, stats.successful, stats.failed, stats.skipped);
})().catch(async error => {
  const chalk = await import('chalk').then(m => m.default);
  console.error(chalk.bgRed('FATAL ERROR:'), chalk.red(error.message));
  process.exit(1);
});
