const { Events } = require('discord.js');
module.exports = function registerLogHandlers(client, config) {
    // Helper om avatar URL op te halen (fallback naar default avatar)
    const getAvatarUrl = (user) => {
        try {
            if (!user) return null;
            return user.displayAvatarURL({ extension: 'png', size: 128 }) || null;
        } catch {
            return null;
        }
    };
    // Kleine helpers (consistent met voiceLogs)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const userTagOrName = (u) => u?.tag || u?.username || 'Onbekend';

    // Vind audit log entry voor timeout wijzigingen met retries
    async function findTimeoutAuditEntry(guild, targetUserId, eventTime) {
        const retryDelay = 1000;
        const maxRetries = 6;
        const windowMs = 15000;
        const start = eventTime - 3000;
        const end = eventTime + windowMs;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const fetched = await guild.fetchAuditLogs({ type: 24, limit: 10 }); // MemberUpdate
                const entries = Array.from(fetched.entries.values());

                // Zoek naar updates specifiek op communication_disabled_until
                const match = entries.find(e =>
                    e?.target?.id === targetUserId &&
                    e.createdTimestamp >= start &&
                    e.createdTimestamp <= end &&
                    (Array.isArray(e.changes) ? e.changes.some(ch => ch.key === 'communication_disabled_until') : true)
                );
                if (match) return match;
            } catch (err) {
                console.warn('[TimeoutLog] Audit fetch error:', err.message);
            }
            await sleep(retryDelay);
        }
        return null;
    }

    // Bepaal de executor van een messageDelete via audit logs (met retries)
    async function findMessageDeleteExecutor(guild, targetUserId, channelId, eventTime) {
        const retryDelay = 1000;
        const maxRetries = 6;
        const windowMs = 15000;
        const start = eventTime - 3000;
        const end = eventTime + windowMs;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const fetched = await guild.fetchAuditLogs({ type: 72, limit: 10 }); // MessageDelete
                const entries = Array.from(fetched.entries.values());

                // 1) Exacte target-match binnen tijdsvenster
                let match = entries.find(e =>
                    e.target?.id === targetUserId &&
                    e.createdTimestamp >= start &&
                    e.createdTimestamp <= end
                );

                // 2) Fallback: binnen tijd + kanaal + count, executor bestaat en is niet de target
                if (!match) {
                    match = entries.find(e =>
                        e.createdTimestamp >= start &&
                        e.createdTimestamp <= end &&
                        (e.extra?.count ?? 0) >= 1 &&
                        (e.extra?.channel?.id ? e.extra.channel.id === channelId : true) &&
                        e.executor && e.executor.id !== targetUserId
                    );
                }

                if (match?.executor) return match.executor;
            } catch (err) {
                console.warn('[MessageLog] Audit fetch error:', err.message);
            }
            await sleep(retryDelay);
        }
        return null;
    }
    // Generieke auditlog helper met retries zodat we niet te vroeg loggen
    async function findAuditEntryWithRetries(guild, type, targetId, eventTime = Date.now(), options = {}) {
        const {
            retryDelay = 1000,
            maxRetries = 6,
            windowMs = 15000,
            preWindowMs = 3000,
            limit = 10,
            predicate
        } = options;
        const start = eventTime - preWindowMs;
        const end = eventTime + windowMs;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const fetched = await guild.fetchAuditLogs({ type, limit });
                const entries = Array.from(fetched.entries.values());

                let match = entries.find(entry =>
                    entry?.target?.id === targetId &&
                    entry.createdTimestamp >= start &&
                    entry.createdTimestamp <= end &&
                    (predicate ? predicate(entry) : true)
                );

                if (!match) {
                    match = entries.find(entry =>
                        entry?.target?.id === targetId &&
                        (predicate ? predicate(entry) : true)
                    );
                }

                if (match) return match;
            } catch (err) {
                console.warn(`[AuditRetry] Fetch error for type ${type}:`, err.message);
            }

            await sleep(retryDelay);
        }

        return null;
    }
    // Join/leave logs invite detectie
    if (!global._joinLeaveHandlersRegistered) {
        global._joinLeaveHandlersRegistered = true;
        if (!global._inviteCache) global._inviteCache = new Map();
        if (!global._userInviters) global._userInviters = new Map();

        const getJoinLeaveLogChannelId = () => {
            // Gebruik expliciet alleen de correcte config key
            return config.logs.joinLeaveChannelId;
        };

        const toColor = (c) => typeof c === 'string' ? parseInt(c, 16) : c;

        const snapshotGuildInvites = async (guild) => {
            try {
                const invites = await guild.invites.fetch();
                const byCode = new Map();
                for (const inv of invites.values()) {
                    // Bewaar extra invite-info zodat we later kunnen tonen via welke code/link iemand gejoined is
                    byCode.set(inv.code, {
                        code: inv.code,
                        url: `https://discord.gg/${inv.code}`,
                        uses: inv.uses ?? 0,
                        inviter: inv.inviter ? { id: inv.inviter.id, tag: inv.inviter.tag } : null
                    });
                }
                global._inviteCache.set(guild.id, byCode);
            } catch (err) {
            }
        };

        // Initialize cache on ready for all guilds we are in
        client.once(Events.ClientReady, async () => {
            const promises = client.guilds.cache.map(g => snapshotGuildInvites(g));
            await Promise.allSettled(promises);
        });

        // Also initialize for new guilds
        client.on('guildCreate', async (guild) => {
            await snapshotGuildInvites(guild);
        });

        // JOIN logger (with inviter detection)
        client.on('guildMemberAdd', async (member) => {
            try {
                const logChannelId = getJoinLeaveLogChannelId();
                if (!logChannelId) return;
                const guild = member.guild;
                const logChannel = guild.channels.cache.get(logChannelId);
                if (!logChannel || !logChannel.isTextBased()) return;

                const before = global._inviteCache.get(guild.id);

                // Fetch latest invites and detect which invite was used
                let usedInvite = null;
                try {
                    const invites = await guild.invites.fetch();
                    const latest = new Map();
                    for (const inv of invites.values()) {
                        latest.set(inv.code, {
                            code: inv.code,
                            url: `https://discord.gg/${inv.code}`,
                            uses: inv.uses ?? 0,
                            inviter: inv.inviter ? { id: inv.inviter.id, tag: inv.inviter.tag } : null
                        });
                    }
                    if (before) {
                        for (const [code, data] of latest.entries()) {
                            const prev = before.get(code);
                            if (!prev) continue;
                            if ((data.uses ?? 0) > (prev.uses ?? 0)) {
                                usedInvite = { code, ...data };
                                break;
                            }
                        }

                        // Fallback: sommige invites zijn single-use en worden verwijderd nadat ze gebruikt zijn.
                        // Controleer of er invites in `before` zitten die niet meer in `latest` voorkomen.
                        if (!usedInvite) {
                            const removed = [];
                            for (const [code, prev] of before.entries()) {
                                if (!latest.has(code)) {
                                    removed.push(prev);
                                }
                            }
                            if (removed.length > 0) {
                                // Kies de meest waarschijnlijke invite: met inviter aanwezig, of met hoogste uses
                                removed.sort((a, b) => {
                                    const ai = a.inviter ? 1 : 0;
                                    const bi = b.inviter ? 1 : 0;
                                    if (bi - ai !== 0) return bi - ai;
                                    return (b.uses ?? 0) - (a.uses ?? 0);
                                });
                                const cand = removed[0];
                                usedInvite = {
                                    code: cand.code,
                                    url: cand.url || (cand.code ? `https://discord.gg/${cand.code}` : null),
                                    uses: cand.uses ?? null,
                                    inviter: cand.inviter || null,
                                    _deleted: true
                                };
                            }
                        }
                    }
                    // Update cache after comparison
                    global._inviteCache.set(guild.id, latest);
                } catch (err) {
                    // ignore, we'll log without inviter
                }

                const inviterText = usedInvite && usedInvite.inviter
                    ? `<@${usedInvite.inviter.id}> (${usedInvite.inviter.tag})`
                    : 'Onbekend';

                const inviteLinkText = usedInvite && usedInvite.code ? `https://discord.gg/${usedInvite.code} (${usedInvite.code})` : 'Onbekend';

                // store for potential leave log later (sla ook code/url op)
                if (usedInvite) {
                    global._userInviters.set(member.id, {
                        inviterId: usedInvite.inviter?.id || null,
                        inviterTag: usedInvite.inviter?.tag || null,
                        code: usedInvite.code || null,
                        url: usedInvite.url || (usedInvite.code ? `https://discord.gg/${usedInvite.code}` : null)
                    });
                }

                const embedColor = toColor(config.general.color);
                const embed = {
                    title: '✅ Gebruiker gejoined',
                    description: [
                        `**User ID:**\n> \`${member.id}\``,
                        `**Gebruiker:**\n> <@${member.id}> (${member.user.tag})`,
                        `**Uitgenodigd door:**\n> ${inviterText}`,
                        `**Invite link:**\n> ${inviteLinkText}`
                    ].join('\n'),
                    color: embedColor,
                    timestamp: new Date().toISOString(),
                    thumbnail: { url: getAvatarUrl(member.user) }
                };
                await logChannel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[JoinLog] Fout bij loggen van join:', err);
            }
        });

        // LEAVE logger (ignore kicks which are handled elsewhere)
        client.on('guildMemberRemove', async (member) => {
            try {
                const logChannelId = getJoinLeaveLogChannelId();
                if (!logChannelId) return;
                const guild = member.guild;
                const logChannel = guild.channels.cache.get(logChannelId);
                if (!logChannel || !logChannel.isTextBased()) return;

                // If there's a recent kick audit entry, let the dedicated kick logger handle it
                try {
                    const fetchedLogs = await guild.fetchAuditLogs({ type: 20, limit: 5 });
                    const auditEntry = fetchedLogs.entries.find(entry => entry.target.id === member.id && Date.now() - entry.createdTimestamp < 5000);
                    if (auditEntry) return; // Was a kick, skip leave log
                } catch (e) {
                    // ignore audit errors; we'll proceed as leave
                }

                const inviter = global._userInviters.get(member.id);
                const inviterText = inviter && inviter.inviterId ? `<@${inviter.inviterId}> (${inviter.inviterTag})` : 'Onbekend';
                const inviteLinkText = inviter && inviter.code ? `${inviter.url || `https://discord.gg/${inviter.code}`} (${inviter.code})` : 'Onbekend';
                const userTag = member.user?.tag || 'Onbekend';

                const embedColor = toColor(config.general.color);
                const embed = {
                    title: '👋 Gebruiker geleaved',
                    description: [
                        `**User ID:**\n> \`${member.id}\``,
                        `**Gebruiker:**\n> <@${member.id}> (${userTag})`,
                        `**Uitgenodigd door:**\n> ${inviterText}`,
                        `**Invite link:**\n> ${inviteLinkText}`
                    ].join('\n'),
                    color: embedColor,
                    timestamp: new Date().toISOString(),
                    thumbnail: { url: getAvatarUrl(member.user) }
                };
                await logChannel.send({ embeds: [embed] });
                // Clean up stored inviter
                global._userInviters.delete(member.id);
            } catch (err) {
                console.error('[LeaveLog] Fout bij loggen van leave:', err);
            }
        });
    }
    // Ban logs
    client.on('guildBanAdd', async (ban) => {
        try {
            const logChannelId = config.logs.moderation.banChannelId;
            let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
            if (!logChannelId) return;
            const guild = ban.guild;
            const logChannel = guild.channels.cache.get(logChannelId);
            if (!logChannel || !logChannel.isTextBased()) return;
            let auditEntry = null;
            try {
                auditEntry = await findAuditEntryWithRetries(
                    guild,
                    22,
                    ban.user.id,
                    Date.now(),
                    {
                        maxRetries: 8,
                        predicate: (entry) => Boolean(entry.executor)
                    }
                );
            } catch (err) {
                console.warn('[BanLog] Kan audit log niet ophalen:', err.message);
            }
            const moderator = auditEntry?.executor;
            if (moderator && moderator.id === guild.client.user.id) return;
            const rawReason = auditEntry?.reason;
            const displayReason = rawReason && rawReason.trim().length > 0 ? rawReason : 'GEEN';
            const embed = {
                title: '🛑 Gebruiker verbannen',
                description: [
                    `**User ID:**\n> \`${ban.user.id}\``,
                    `**Gebruiker:**\n> <@${ban.user.id}> (${ban.user.tag})`,
                    moderator ? `**Verbannen door:**\n> <@${moderator.id}> (${moderator.tag})` : '**Verbannen door:**\n> Onbekend',
                    `**Reden:**\n> ${displayReason}`
                ].join('\n'),
                color: 0xFF0000,
                timestamp: new Date().toISOString(),
                thumbnail: { url: getAvatarUrl(ban.user) }
            };
            await logChannel.send({ embeds: [embed] });
        } catch (err) {
            console.error('[BanLog] Fout bij loggen van ban:', err);
        }
    });
    // Unban logs
    client.on('guildBanRemove', async (ban) => {
        try {
            const logChannelId = config.logs.moderation.unbanChannelId;
            let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
            if (!logChannelId) return;
            const guild = ban.guild;
            const logChannel = guild.channels.cache.get(logChannelId);
            if (!logChannel || !logChannel.isTextBased()) return;
            let auditEntry = null;
            try {
                const fetchedLogs = await guild.fetchAuditLogs({ type: 23, limit: 5 });
                auditEntry = fetchedLogs.entries.find(entry => entry.target.id === ban.user.id && Date.now() - entry.createdTimestamp < 5000);
            } catch (err) {
                console.warn('[UnbanLog] Kan audit log niet ophalen:', err.message);
            }
            const moderator = auditEntry?.executor;
            if (moderator && moderator.id === guild.client.user.id) return;
            const embed = {
                title: '🔓 Gebruiker ge-unbanned',
                description: [
                    `**User ID:**\n> \`${ban.user.id}\``,
                    `**Gebruiker:**\n> <@${ban.user.id}> (${ban.user.tag})`,
                    moderator ? `**Ge-unbanned door:**\n> <@${moderator.id}> (${moderator.tag})` : '**Ge-unbanned door:**\n> Onbekend',
                ].join('\n'),
                color: embedColor,
                timestamp: new Date().toISOString(),
                thumbnail: { url: getAvatarUrl(ban.user) }
            };
            await logChannel.send({ embeds: [embed] });
        } catch (err) {
            console.error('[UnbanLog] Fout bij loggen van unban:', err);
        }
    });
    // Kick logs (ignore bot actions)
    client.on('guildMemberRemove', async (member) => {
        try {
            const logChannelId = config.logs.moderation.kickChannelId;
            let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
            if (!logChannelId) return;
            const guild = member.guild;
            const logChannel = guild.channels.cache.get(logChannelId);
            if (!logChannel || !logChannel.isTextBased()) return;

            let auditEntry = null;
            try {
                const fetchedLogs = await guild.fetchAuditLogs({ type: 20, limit: 5 });
                auditEntry = fetchedLogs.entries.find(entry => entry.target.id === member.id && Date.now() - entry.createdTimestamp < 5000);
            } catch (err) {
                console.warn('[KickLog] Kan audit log niet ophalen:', err.message);
            }

            if (!auditEntry) return;

            const moderator = auditEntry.executor;
            if (moderator && moderator.id === guild.client.user.id) return;

            const reason = auditEntry.reason || 'Geen reden opgegeven';
            const userTag = member.user?.tag || 'Onbekend';

            const embed = {
                title: '🚪 Gebruiker gekickt',
                description: [
                    `**User ID:**\n> \`${member.id}\``,
                    `**Gebruiker:**\n> <@${member.id}> (${userTag})`,
                    moderator ? `**Gekickt door:**\n> <@${moderator.id}> (${moderator.tag})` : '**Gekickt door:**\n> Onbekend',
                    `**Reden:**\n> ${reason}`
                ].join('\n'),
                color: embedColor,
                timestamp: new Date().toISOString(),
                thumbnail: { url: getAvatarUrl(member.user) }
            };

            await logChannel.send({ embeds: [embed] });
        } catch (err) {
            console.error('[KickLog] Fout bij loggen van kick:', err);
        }
    });
    // Timeout (communication disabled) logs -> gebruiken warnLogChannelId
    if (!global._timeoutLogHandlerRegistered) {
        global._timeoutLogHandlerRegistered = true;
        client.on('guildMemberUpdate', async (oldMember, newMember) => {
            try {
                // Sla bot updates over
                if (newMember.user?.bot) return;
                const oldTs = oldMember.communicationDisabledUntilTimestamp || 0;
                const newTs = newMember.communicationDisabledUntilTimestamp || 0;
                if (oldTs === newTs) return; // Geen wijziging in timeout

                const logChannelId = config.logs.moderation.warnChannelId; // Zelfde kanaal als warns
                if (!logChannelId) return;
                const guild = newMember.guild;
                let logChannel = guild.channels.cache.get(logChannelId);
                if (!logChannel) {
                    try { logChannel = await guild.channels.fetch(logChannelId); } catch {}
                }
                if (!logChannel || !logChannel.isTextBased()) return;

                const embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;

                // Bepaal type wijziging
                const now = Date.now();
                let actionType = 'gewijzigd';
                if (!oldTs && newTs) actionType = 'ingesteld';
                else if (oldTs && !newTs) actionType = (now >= oldTs ? 'verlopen' : 'verwijderd');
                else if (oldTs && newTs) actionType = (newTs > oldTs ? 'verlengd' : 'verkort');

                // Audit log (MemberUpdate = type 24) om uitvoerder en reden te vinden (niet aanwezig bij automatisch verlopen)
                let moderator = null;
                let reason = null;
                if (actionType !== 'verlopen') {
                    const eventTime = Date.now();
                    const entry = await findTimeoutAuditEntry(guild, newMember.id, eventTime);
                    if (entry) {
                        const exec = entry.executor;
                        if (exec && exec.id !== guild.client.user.id) {
                            moderator = exec;
                        }
                        reason = entry.reason || null;
                    }
                }

                // Hulpfunctie voor duur formatting
                const formatDuration = (ms) => {
                    if (ms <= 0) return '0s';
                    const parts = [];
                    const units = [
                        ['d', 86400000],
                        ['u', 3600000],
                        ['m', 60000],
                        ['s', 1000]
                    ];
                    for (const [label, size] of units) {
                        const val = Math.floor(ms / size);
                        if (val > 0) {
                            parts.push(`${val}${label}`);
                            ms -= val * size;
                        }
                    }
                    return parts.slice(0, 3).join(' ');
                };

                let lines = [
                    `**Gebruiker:**\n> <@${newMember.id}> (${newMember.user?.tag || 'Onbekend'})`,
                ];

                if (actionType === 'ingesteld') {
                    const remaining = newTs - now;
                    lines.push(`**Duur:**\n> ${formatDuration(remaining)}`);
                    lines.push(`**Tot:**\n> <t:${Math.floor(newTs / 1000)}:f>`);
                } else if (actionType === 'verwijderd') {
                    const remaining = oldTs - now;
                    lines.push(`**Resterend (geannuleerd):**\n> ${remaining > 0 ? formatDuration(remaining) : '—'}`);
                } else if (actionType === 'verlopen') {
                    lines.push(`**Eindigde om:**\n> <t:${Math.floor(oldTs / 1000)}:f>`);
                } else if (actionType === 'verlengd') {
                    const diff = newTs - oldTs;
                    const totalLeft = newTs - now;
                    lines.push(`**Verlengd met:**\n> ${formatDuration(diff)}`);
                    lines.push(`**Nieuwe resterende tijd:**\n> ${formatDuration(totalLeft)}`);
                    lines.push(`**Nieuwe eindtijd:**\n> <t:${Math.floor(newTs / 1000)}:f>`);
                } else if (actionType === 'verkort') {
                    const diff = oldTs - newTs;
                    const totalLeft = newTs - now;
                    lines.push(`**Verkort met:**\n> ${formatDuration(diff)}`);
                    lines.push(`**Nieuwe resterende tijd:**\n> ${totalLeft > 0 ? formatDuration(totalLeft) : '—'}`);
                    lines.push(`**Nieuwe eindtijd:**\n> <t:${Math.floor(newTs / 1000)}:f>`);
                }

                if (moderator) {
                    lines.push(`**Uitgevoerd door:**\n> <@${moderator.id}> (${moderator.tag || moderator.username})`);
                } else if (actionType === 'verlopen') {
                    lines.push('**Uitgevoerd door:**\n> Automatisch');
                } else if (actionType !== 'ingesteld') {
                    lines.push('**Uitgevoerd door:**\n> Onbekend');
                }

                if (reason) {
                    lines.push(`**Reden:**\n> ${reason}`);
                }

                const titleMap = {
                    ingesteld: '⏱️ Timeout ingesteld',
                    verwijderd: '⏱️ Timeout verwijderd',
                    verlopen: '⏱️ Timeout verlopen',
                    verlengd: '⏱️ Timeout verlengd',
                    verkort: '⏱️ Timeout verkort',
                    gewijzigd: '⏱️ Timeout gewijzigd'
                };

                const embed = {
                    title: titleMap[actionType] || '⏱️ Timeout',
                    description: lines.join('\n'),
                    color: embedColor,
                    timestamp: new Date().toISOString(),
                    thumbnail: { url: getAvatarUrl(newMember.user) }
                };

                await logChannel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[TimeoutLog] Fout bij loggen van timeout wijziging:', err);
            }
        });
    }
    // One-time registration for message edit/delete logs
    if (!global._messageLogHandlersRegistered) {
        global._messageLogHandlersRegistered = true;
        const recentEditLogs = new Set();
        const recentDeleteLogs = new Set();
        // Debounce to avoid duplicate edit logs
        client.on('messageUpdate', async (oldMessage, newMessage) => {
            if (recentEditLogs.has(oldMessage.id)) return;
            recentEditLogs.add(oldMessage.id);
            setTimeout(() => recentEditLogs.delete(oldMessage.id), 1500);
            try {
                if (oldMessage.partial || newMessage.partial) return;
                if (oldMessage.author?.bot) return;
                if (oldMessage.content === newMessage.content && oldMessage.attachments.size === newMessage.attachments.size) return;
                const logChannelId = config.logs.messageChannelId;
                let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
                if (!logChannelId) return;
                const guild = newMessage.guild;
                if (!guild) return;
                const logChannel = guild.channels.cache.get(logChannelId);
                if (!logChannel || !logChannel.isTextBased()) return;
                const oldAtt = [...oldMessage.attachments.values()].map(a => `[${a.name}](${a.url})`).join('\n') || 'Geen';
                const newAtt = [...newMessage.attachments.values()].map(a => `[${a.name}](${a.url})`).join('\n') || 'Geen';
                const formatMultiline = (text) => text.replace(/\n/g, '\n> ').slice(0, 1024);
                const oldContent = formatMultiline(oldMessage.content ?? 'Geen');
                const newContent = formatMultiline(newMessage.content ?? 'Geen');
                const embed = {
                    title: '✏️ Bericht bewerkt',
                    description: [
                        `**Kanaal:**\n> <#${oldMessage.channel.id}>`,
                        `**Gebruiker:**\n> <@${oldMessage.author.id}> (${oldMessage.author.tag})`,
                        `**Bericht ID:**\n> \`${oldMessage.id}\``,
                        `**Oude inhoud:**\n> ${oldContent}`,
                        `**Nieuwe inhoud:**\n> ${newContent}`,
                        `**Oude Attachments:**\n> ${oldAtt.replace(/\n/g, '\n> ')}`,
                        `**Nieuwe Attachments:**\n> ${newAtt.replace(/\n/g, '\n> ')}`
                    ].join('\n'),
                    color: 0xFFFF00,
                    timestamp: new Date().toISOString(),
                    url: newMessage.url,
                    thumbnail: { url: getAvatarUrl(oldMessage.author) }
                };
                await logChannel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[MessageLog] Fout bij loggen van messageUpdate:', err);
            }
        });
        // Debounce to avoid duplicate delete logs
        client.on('messageDelete', async (message) => {
            if (recentDeleteLogs.has(message.id)) return;
            recentDeleteLogs.add(message.id);
            setTimeout(() => recentDeleteLogs.delete(message.id), 1500);
            try {
                if (message.partial) {
                    try {
                        await message.fetch();
                    } catch {
                        return;
                    }
                }
                if (message.author?.bot) return;
                const logChannelId = config.logs.messageChannelId;
                let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
                if (!logChannelId) return;
                const guild = message.guild;
                if (!guild) return;
                const logChannel = guild.channels.cache.get(logChannelId);
                if (!logChannel || !logChannel.isTextBased()) return;
                const eventTime = Date.now();
                const deleter = await findMessageDeleteExecutor(guild, message.author.id, message.channel?.id, eventTime);
                const att = [...message.attachments.values()].map(a => `[${a.name}](${a.url})`).join('\n') || 'Geen';
                const content = (message.content ?? 'Geen').replace(/\n/g, '\n> ').slice(0, 1024);
                const embed = {
                    title: '🗑️ Bericht verwijderd',
                    description: [
                        `**Kanaal:**\n> <#${message.channel.id}>`,
                        `**Gebruiker:**\n> <@${message.author.id}> (${message.author.tag})`,
                        deleter ? `**Verwijderd door:**\n> <@${deleter.id}> (${userTagOrName(deleter)})` : `**Verwijderd door:**\n> Zelf`,
                        `**Bericht ID:**\n> \`${message.id}\``,
                        `**Inhoud:**\n> ${content}`,
                        `**Attachments:**\n> ${att.replace(/\n/g, '\n> ')}`
                    ].join('\n'),
                    color: 0xFF0000,
                    timestamp: new Date().toISOString(),
                    thumbnail: { url: getAvatarUrl(message.author) }
                };
                await logChannel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[MessageLog] Fout bij loggen van messageDelete:', err);
            }
        });
    }
};