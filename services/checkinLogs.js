const { EmbedBuilder } = require('discord.js');
const config = require('../config.js');

const COLOR_SUCCESS = 0x57F287;
const COLOR_FAIL = 0xED4245;
const LOG_SEND_INTERVAL_MS = Number(process.env.CHECKIN_LOG_SEND_INTERVAL_MS || 250);
const LOG_QUEUE_MAX = Number(process.env.CHECKIN_LOG_QUEUE_MAX || 5000);
const LOG_RETRY_MAX = Number(process.env.CHECKIN_LOG_RETRY_MAX || 4);

const logQueue = [];
let queueRunning = false;
let droppedLogCount = 0;

function getCheckinLogChannel(guild) {
    if (!guild) return null;
    const id = config.logs?.checkinChannelId || config.logs?.miscChannelId;
    if (!id) return null;
    const channel = guild.channels.cache.get(id);
    return channel && channel.isTextBased() ? channel : null;
}

function roundWord(word) {
    const clean = String(word ?? '').trim();
    return clean.length ? clean : 'Onbekend';
}

function getUsername(guild, userId) {
    const member = guild?.members?.cache?.get(userId);
    return member?.user?.username || member?.displayName || 'Onbekend';
}

function unix(date) {
    return Math.floor((date || new Date()).getTime() / 1000);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(err, retryCount) {
    const retryAfterSeconds = Number(
        err?.data?.retry_after ?? err?.rawError?.retry_after ?? 0
    );
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.ceil(retryAfterSeconds * 1000) + 100;
    }

    // Backoff for transient network or API issues.
    return Math.min(500 * (2 ** retryCount), 10_000);
}

function isRetryableError(err) {
    const status = Number(err?.status || 0);
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
}

async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;

    while (logQueue.length > 0) {
        const item = logQueue.shift();
        try {
            await item.channel.send(item.payload);
        } catch (err) {
            if (isRetryableError(err) && item.retries < LOG_RETRY_MAX) {
                const delay = getRetryDelayMs(err, item.retries);
                item.retries += 1;
                await sleep(delay);
                logQueue.unshift(item);
                continue;
            }
            console.error('[CheckinLogs] Failed to send log entry:', err);
        }

        // Smooths burst traffic so one checkin wave does not hammer channel routes.
        if (LOG_SEND_INTERVAL_MS > 0) {
            await sleep(LOG_SEND_INTERVAL_MS);
        }
    }

    if (droppedLogCount > 0) {
        console.warn(`[CheckinLogs] Dropped ${droppedLogCount} log entries because queue limit (${LOG_QUEUE_MAX}) was reached.`);
        droppedLogCount = 0;
    }

    queueRunning = false;
}

async function sendLog(guild, embed) {
    const channel = getCheckinLogChannel(guild);
    if (!channel) return;

    if (logQueue.length >= LOG_QUEUE_MAX) {
        droppedLogCount += 1;
        return;
    }

    logQueue.push({
        channel,
        payload: { embeds: [embed] },
        retries: 0
    });

    runQueue().catch((err) => {
        queueRunning = false;
        console.error('[CheckinLogs] Queue worker crashed:', err);
    });
}

async function logCheckinSuccess({ guild, userId, roundNumber, word, sessionName, at = new Date() }) {
    const ts = unix(at);
    const embed = new EmbedBuilder()
        .setTitle('✅ Check-in Gelukt')
        .setDescription([
            `**Gebruiker:**\n> <@${userId}> (${getUsername(guild, userId)})`,
            sessionName ? `**Sessie:**\n> ${sessionName}` : null,
            `**Ronde:**\n> ${roundNumber}`,
            `**Woord:**\n> ${roundWord(word)}`,
            `**Tijd:**\n> <t:${ts}:F> (<t:${ts}:T>)`
        ].filter(Boolean).join('\n'))
        .setColor(COLOR_SUCCESS)
        .setTimestamp(at);

    await sendLog(guild, embed);
}

async function logCheckinWrongWord({ guild, userId, roundNumber, expectedWord, submittedWord, sessionName, at = new Date() }) {
    const ts = unix(at);
    const embed = new EmbedBuilder()
        .setTitle('❌ Check-in Afgevallen (Verkeerd Woord)')
        .setDescription([
            `**Gebruiker:**\n> <@${userId}> (${getUsername(guild, userId)})`,
            sessionName ? `**Sessie:**\n> ${sessionName}` : null,
            `**Ronde:**\n> ${roundNumber}`,
            `**Verwacht Woord:**\n> ${roundWord(expectedWord)}`,
            `**Ingevuld Woord:**\n> ${roundWord(submittedWord)}`,
            `**Tijd:**\n> <t:${ts}:F> (<t:${ts}:T>)`
        ].filter(Boolean).join('\n'))
        .setColor(COLOR_FAIL)
        .setTimestamp(at);

    await sendLog(guild, embed);
}

async function logCheckinMissed({ guild, userId, roundNumber, word, sessionName, at = new Date() }) {
    const ts = unix(at);
    const embed = new EmbedBuilder()
        .setTitle('❌ Check-in Gemist')
        .setDescription([
            `**Gebruiker:**\n> <@${userId}> (${getUsername(guild, userId)})`,
            sessionName ? `**Sessie:**\n> ${sessionName}` : null,
            `**Ronde:**\n> ${roundNumber}`,
            `**Woord:**\n> ${roundWord(word)}`,
            `**Tijd:**\n> <t:${ts}:F> (<t:${ts}:T>)`
        ].filter(Boolean).join('\n'))
        .setColor(COLOR_FAIL)
        .setTimestamp(at);

    await sendLog(guild, embed);
}

module.exports = {
    logCheckinSuccess,
    logCheckinWrongWord,
    logCheckinMissed
};
