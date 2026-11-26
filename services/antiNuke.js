const { AuditLogEvent } = require('discord.js');

module.exports = function initializeAntiNukeService(client, pool, config) {
    // In‑memory counters per user: destructive vs create actions
    const activity = new Map(); // userId -> { count, lastActionAt, types: string[] }
    const activityCreate = new Map(); // userId -> { count, lastActionAt, types: string[] }

    // Windows & thresholds (config.js)
    const cooldownMs = Math.max(1, Number(config.antiNuke.cooldownInSeconds || 100)) * 1000;
    const auditWindowMs = Math.max(1, Number(config.antiNuke.auditWindowSeconds || 10)) * 1000;
    const threshold = Math.max(1, Number(config.antiNuke.threshold || 3));
    const createThreshold = Math.max(1, Number(config.antiNuke.createThreshold || config.antiNuke.threshold || 3));

    // Whitelist (users & roles)
    const whitelist = Array.isArray(config.antiNuke.whitelistUserIds) ? config.antiNuke.whitelistUserIds : [];
    const whitelistRoles = Array.isArray(config.antiNuke.whitelistRoleIds) ? config.antiNuke.whitelistRoleIds : [];

    const isWhitelisted = (userId) => whitelist.includes(userId);

    // Bypass: bot zelf, whitelisted users of whitelisted rollen
    async function shouldBypass(guild, userId) {
        if (!userId) return false;
        if (userId === client.user.id) return true;
        if (isWhitelisted(userId)) return true;
        if (!whitelistRoles.length) return false;
        try {
            const m = await guild.members.fetch(userId);
            return m.roles.cache.some(r => whitelistRoles.includes(r.id));
        } catch {
            return false;
        }
    }

    // Vind uitvoerder in recente audit logs (optioneel target matchen)
    async function getRecentExecutorFromAudit(guild, type, targetId) {
        try {
            const logs = await guild.fetchAuditLogs({ type, limit: 5 });
            if (!logs || !logs.entries?.size) return null;
            const now = Date.now();
            const match = logs.entries.find(e => {
                if (!e) return false;
                if (now - e.createdTimestamp > auditWindowMs) return false;
                if (targetId && e.targetId !== targetId) return false;
                return true;
            });
            return match?.executorId || null;
        } catch (err) {
            console.warn('[AntiNuke] Kan audit logs niet ophalen:', err?.message || err);
            return null;
        }
    }

    function resetIfExpired(record) {
        if (!record) return { count: 0, lastActionAt: 0, types: [] };
        if ((Date.now() - record.lastActionAt) > cooldownMs) {
            return { count: 0, lastActionAt: 0, types: [] };
        }
        return record;
    }

    // Meld whitelisted admins (DM) en alertLogChannel
    async function notifyAdmins(guild, offenderId, offenderName, count, types, outcome, thresholdUsed) {
        const embed = {
            title: '🚨 Anti‑Nuke Alarm',
            description: [
                `**Gebruiker:**\n> <@${offenderId}> (${offenderName || 'onbekend'})`,
                `**Acties (teller):**\n> ${count} / ${thresholdUsed ?? '—'}`,
                `**Gedetecteerde types:**\n> ${types.slice(-10).join(', ') || '—'}`,
                `**Resultaat:**\n> ${outcome || 'onbekend'}`
            ].join('\n'),
            color: 0xFF0000,
            timestamp: new Date().toISOString()
        };

        for (const adminId of whitelist) {
            try {
                const m = await guild.members.fetch(adminId).catch(() => null);
                const user = m?.user ?? (await client.users.fetch(adminId).catch(() => null));
                if (user) {
                    await user.send({ embeds: [embed] });
                }
            } catch (e) {}
        }

        if (config.logs.alertChannelId) {
            const ch = guild.channels.cache.get(config.logs.alertChannelId);
            if (ch && ch.isTextBased()) {
                ch.send({ embeds: [embed] }).catch(() => {});
            }
        }
    }

    // Handhaving: verwijder moderator rol bij drempel (geen ban/kick meer)
    async function enforceModeratorStrip(guild, userId, data) {
        try {
            const moderatorRoleId = config.roles.moderatorId;
            const reason = 'Anti‑Nuke: verdacht massaal beheer (drempel bereikt)';
            let outcome = '';

            if (!moderatorRoleId) {
                // Config mist moderator rol ID
                let offenderName = 'onbekend';
                try {
                    const u = await client.users.fetch(userId);
                    if (u?.username) offenderName = u.username;
                } catch {}
                outcome = 'moderatorRoleId ontbreekt (geen actie)';
                await notifyAdmins(guild, userId, offenderName, data.count, data.types, outcome, data.thresholdUsed ?? threshold);
                return;
            }

            const member = await guild.members.fetch(userId).catch(() => null);

            if (!member) {
                let offenderName = 'onbekend';
                try {
                    const u = await client.users.fetch(userId);
                    if (u?.username) offenderName = u.username;
                } catch {}
                outcome = 'gebruiker niet in guild (geen rol verwijderd)';
                await notifyAdmins(guild, userId, offenderName, data.count, data.types, outcome, data.thresholdUsed ?? threshold);
                return;
            }

            if (member.id === client.user.id) return; // bot zelf overslaan
            if (member.id === guild.ownerId) {
                const name = member.user.username;
                outcome = 'owner: rol niet verwijderd';
                await notifyAdmins(guild, userId, name, data.count, data.types, outcome, data.thresholdUsed ?? threshold);
                return;
            }

            // Verwijder alleen de moderator rol indien aanwezig
            const hasModRole = member.roles.cache.has(moderatorRoleId);
            if (!hasModRole) {
                outcome = 'had geen moderator rol';
            } else {
                try {
                    await member.roles.remove(moderatorRoleId, reason);
                    outcome = 'moderator rol verwijderd';
                } catch (e) {
                    outcome = 'kon moderator rol niet verwijderen (perms/hierarchie)';
                }
            }

            const name = member.user.username;
            await notifyAdmins(guild, userId, name, data.count, data.types, outcome || 'onbekend', data.thresholdUsed ?? threshold);
        } catch (err) {
            console.warn('[AntiNuke] Rol strip mislukte:', err?.message || err);
        }
    }

    // Log verdacht (delete/ban/kick) en handhaaf bij drempel
    async function recordSuspiciousAction(guild, executorId, actionType) {
        try {
            if (!executorId) return;
            if (await shouldBypass(guild, executorId)) return;

            const current = resetIfExpired(activity.get(executorId));
            const updated = {
                count: current.count + 1,
                lastActionAt: Date.now(),
                types: [...current.types, actionType],
                thresholdUsed: threshold
            };
            activity.set(executorId, updated);

            if (updated.count >= threshold) {
                await enforceModeratorStrip(guild, executorId, updated);
                activity.delete(executorId);
            }

            // Opruimen na cooldown
            setTimeout(() => {
                const rec = activity.get(executorId);
                if (!rec) return;
                if ((Date.now() - rec.lastActionAt) > cooldownMs) {
                    activity.delete(executorId);
                }
            }, cooldownMs + 5_000);
        } catch (err) {
            console.warn('[AntiNuke] recordSuspiciousAction error:', err?.message || err);
        }
    }

    // Log create‑acties (kanalen/rollen) en handhaaf bij drempel
    async function recordCreateAction(guild, executorId, actionType) {
        try {
            if (!executorId) return;
            if (await shouldBypass(guild, executorId)) return;

            const current = resetIfExpired(activityCreate.get(executorId));
            const updated = {
                count: current.count + 1,
                lastActionAt: Date.now(),
                types: [...current.types, actionType],
                thresholdUsed: createThreshold
            };
            activityCreate.set(executorId, updated);

            if (updated.count >= createThreshold) {
                await enforceModeratorStrip(guild, executorId, updated);
                activityCreate.delete(executorId);
            }

            // Opruimen na cooldown
            setTimeout(() => {
                const rec = activityCreate.get(executorId);
                if (!rec) return;
                if ((Date.now() - rec.lastActionAt) > cooldownMs) {
                    activityCreate.delete(executorId);
                }
            }, cooldownMs + 5_000);
        } catch (err) {
            console.warn('[AntiNuke] recordCreateAction error:', err?.message || err);
        }
    }

    // Events + audit logs
    client.on('channelDelete', async (channel) => {
        const guild = channel?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.ChannelDelete, channel.id);
        if (executorId) {
            await recordSuspiciousAction(guild, executorId, 'channelDelete');
        }
    });

    client.on('roleDelete', async (role) => {
        const guild = role?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.RoleDelete, role.id);
        if (executorId) {
            await recordSuspiciousAction(guild, executorId, 'roleDelete');
        }
    });

    client.on('channelCreate', async (channel) => {
        const guild = channel?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.ChannelCreate, channel.id);
        if (executorId) {
            await recordCreateAction(guild, executorId, 'channelCreate');
        }
    });

    client.on('roleCreate', async (role) => {
        const guild = role?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.RoleCreate, role.id);
        if (executorId) {
            await recordCreateAction(guild, executorId, 'roleCreate');
        }
    });

    client.on('guildBanAdd', async (ban) => {
        const guild = ban?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.MemberBanAdd, ban.user?.id);
        if (executorId) {
            await recordSuspiciousAction(guild, executorId, 'memberBan');
        }
    });

    // Unban via audit log
    client.on('guildBanRemove', async (ban) => {
        const guild = ban?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.MemberBanRemove, ban.user?.id);
        if (executorId) {
            await recordSuspiciousAction(guild, executorId, 'memberUnban');
        }
    });

    // Kick via audit log
    client.on('guildMemberRemove', async (member) => {
        const guild = member?.guild;
        if (!guild) return;
        const executorId = await getRecentExecutorFromAudit(guild, AuditLogEvent.MemberKick, member.id);
        if (executorId) {
            await recordSuspiciousAction(guild, executorId, 'memberKick');
        }
    });

    // Luister naar interne bot events zodat we moderator-acties die via commands gaan
    // kunnen toeschrijven aan de menselijke uitvoerder (niet de bot zelf)
    client.on('antiNuke:modAction', async (payload) => {
        try {
            const { guildId, executorId, type } = payload || {};
            if (!guildId || !executorId || !type) return;
            const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) return;
            // Beschouw kicks/bans/unbans als verdacht (destructief)
            const destructive = new Set(['memberBan', 'memberKick', 'memberUnban']);
            if (destructive.has(type)) {
                await recordSuspiciousAction(guild, executorId, type);
            }
        } catch (err) {
            console.warn('[AntiNuke] antiNuke:modAction handler error:', err?.message || err);
        }
    });

    console.log('[AntiNuke] Service geactiveerd:', { threshold, createThreshold, cooldownSec: cooldownMs / 1000, whitelist: whitelist.length });
};
