const { AuditLogEvent } = require("discord.js");

module.exports = function registerVoiceLogs(client, config) {
    const LOG_CHANNEL_ID = config.logs.voiceChannelId;
    const COLORS = {
        join: 0x57F287,
        leave: 0xff0000,
        move: 0xfee75c,
        camera: 0x5865F2,
        stream: 0x9b59b6,
        cameraOff: 0x747F8D,
        streamOff: 0xE67E22
    };

    if (!LOG_CHANNEL_ID) {
        console.warn("[VoiceLogs] logs.voiceChannelId ontbreekt in config.js.");
        return;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function getLogChannel(guild) {
        if (!guild) return null;
        let ch = guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!ch) {
            try { ch = await guild.channels.fetch(LOG_CHANNEL_ID); } catch (_) {}
        }
        return ch?.isTextBased() ? ch : null;
    }

    function nowEpochSeconds() {
        return Math.floor(Date.now() / 1000);
    }

    function userTagOrName(user) {
        return user?.tag || user?.username || 'Onbekend';
    }

    /**
     * Zoekt recentste executor bij MemberMove of MemberDisconnect
     * Werkt ook wanneer target ontbreekt (match op tijd + count + executor)
     */
    async function findVoiceExecutor(guild, type, targetId, eventTime) {
        const retryDelay = 1000;
        const maxRetries = 6;
        const windowMs = 15000;
        const start = eventTime - 3000;
        const end = eventTime + windowMs;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const fetched = await guild.fetchAuditLogs({ type, limit: 10 });
                const entries = Array.from(fetched.entries.values());

                // 1️⃣ Probeer eerst exacte target-match
                let match = entries.find(e =>
                    e.target?.id === targetId &&
                    e.createdTimestamp >= start &&
                    e.createdTimestamp <= end
                );

                // 2️⃣ Als target ontbreekt, fallback: match op tijd + executor + count
                if (!match) {
                    match = entries.find(e =>
                        e.createdTimestamp >= start &&
                        e.createdTimestamp <= end &&
                        e.extra?.count >= 1 && // "moved X users"
                        e.executor?.id !== targetId
                    );
                }

                if (match && match.executor) {
                    return match.executor;
                }
            } catch (err) {
                console.warn("[VoiceLogs] Audit fetch error:", err.message);
            }
            await sleep(retryDelay);
        }

        return null;
    }

    client.on("voiceStateUpdate", async (oldState, newState) => {
        try {
            const guild = newState.guild || oldState.guild;
            if (!guild) return;
            const logChannel = await getLogChannel(guild);
            if (!logChannel) return;

            const userId = newState.id || oldState.id;
            const user = newState.member?.user || oldState.member?.user || await guild.client.users.fetch(userId).catch(() => null);
            if (!user || user.bot) return;

            const oldId = oldState.channelId;
            const newId = newState.channelId;
            const epoch = nowEpochSeconds();

            // CAMERA ON (log only when turned ON)
            if (!oldState.selfVideo && newState.selfVideo) {
                const chId = newId || oldId;
                if (chId) {
                    await logChannel.send({
                        embeds: [{
                            title: "📷 Camera aan",
                            description: [
                                `**Kanaal:**\n> <#${chId}>`,
                                `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                                `**User ID:**\n> \`${userId}\``,
                                `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                            ].join("\n"),
                            color: COLORS.camera,
                            thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }
            }

            // STREAM ON (log only when turned ON)
            if (!oldState.streaming && newState.streaming) {
                const chId = newId || oldId;
                if (chId) {
                    await logChannel.send({
                        embeds: [{
                            title: "📺 Stream gestart",
                            description: [
                                `**Kanaal:**\n> <#${chId}>`,
                                `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                                `**User ID:**\n> \`${userId}\``,
                                `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                            ].join("\n"),
                            color: COLORS.stream,
                            thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }
            }

            // CAMERA OFF (log only when turned OFF)
            if (oldState.selfVideo && !newState.selfVideo) {
                const chId = newId || oldId;
                if (chId) {
                    await logChannel.send({
                        embeds: [{
                            title: "📷 Camera uit",
                            description: [
                                `**Kanaal:**\n> <#${chId}>`,
                                `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                                `**User ID:**\n> \`${userId}\``,
                                `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                            ].join("\n"),
                            color: COLORS.cameraOff,
                            thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }
            }

            // STREAM OFF (log only when turned OFF)
            if (oldState.streaming && !newState.streaming) {
                const chId = newId || oldId;
                if (chId) {
                    await logChannel.send({
                        embeds: [{
                            title: "📺 Stream gestopt",
                            description: [
                                `**Kanaal:**\n> <#${chId}>`,
                                `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                                `**User ID:**\n> \`${userId}\``,
                                `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                            ].join("\n"),
                            color: COLORS.streamOff,
                            thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }
            }

            // JOIN
            if (!oldId && newId) {
                const joinedChannelId = newId;
                const joinEpoch = epoch; // bewaar exacte tijd van join voor perfecte timestamp

                let stillInSame = false;
                try {
                    const freshMember = await guild.members.fetch(userId);
                    const currentChannelId = freshMember?.voice?.channelId || freshMember?.voice?.channel?.id || null;
                    stillInSame = currentChannelId === joinedChannelId;
                } catch (_) {
                    // Als we de member niet kunnen fetchen, stuur geen log om ruis te vermijden
                    stillInSame = false;
                }

                if (!stillInSame) return;
                await logChannel.send({
                    embeds: [{
                        title: "🔊 Voice join",
                        description: [
                            `**Kanaal:**\n> <#${joinedChannelId}>`,
                            `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                            `**User ID:**\n> \`${userId}\``,
                            `**Tijdstip:**\n> <t:${joinEpoch}:F> - <t:${joinEpoch}:T>`
                        ].join("\n"),
                        color: COLORS.join,
                        thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                        timestamp: new Date().toISOString()
                    }]
                });
                return;
            }

            // LEAVE
            if (oldId && !newId) {
                const eventTime = Date.now();
                const executor = await findVoiceExecutor(
                    guild,
                    AuditLogEvent.MemberDisconnect,
                    userId,
                    eventTime
                );

                const lines = [
                    `**Kanaal:**\n> <#${oldId}>`,
                    `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                    `**User ID:**\n> \`${userId}\``,
                    executor
                        ? `**Uit kanaal gezet door:**\n> <@${executor.id}> (${userTagOrName(executor)})`
                        : `**Uitgevoerd door:**\n> Zelf`,
                    `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                ];

                await logChannel.send({
                    embeds: [{
                        title: executor ? "⛔ Voice disconnect" : "🔇 Voice leave",
                        description: lines.join("\n"),
                        color: COLORS.leave,
                        thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                        timestamp: new Date().toISOString()
                    }]
                });
                return;
            }

            // MOVE
            if (oldId && newId && oldId !== newId) {
                const eventTime = Date.now();
                const executor = await findVoiceExecutor(
                    guild,
                    AuditLogEvent.MemberMove,
                    userId,
                    eventTime
                );

                const lines = [
                    `**Van:**\n> <#${oldId}>`,
                    `**Naar:**\n> <#${newId}>`,
                    `**Gebruiker:**\n> <@${userId}> (${userTagOrName(user)})`,
                    `**User ID:**\n> \`${userId}\``,
                    executor
                        ? `**Uitgevoerd door:**\n> <@${executor.id}> (${userTagOrName(executor)})`
                        : `**Uitgevoerd door:**\n> Zelf`,
                    `**Tijdstip:**\n> <t:${epoch}:F> - <t:${epoch}:T>`
                ];

                await logChannel.send({
                    embeds: [{
                        title: executor ? "🔁 Voice verplaatst (modactie)" : "🔁 Voice verplaatst",
                        description: lines.join("\n"),
                        color: COLORS.move,
                        thumbnail: { url: user.displayAvatarURL({ size: 256 }) },
                        timestamp: new Date().toISOString()
                    }]
                });
                return;
            }
        } catch (err) {
            console.error("[VoiceLogs] voiceStateUpdate error:", err);
        }
    });

    console.log("[VoiceLogs] Verbeterde auditlog-matching actief.");
};
