module.exports = function registerMiscLogs(client, config) {
    const getLogChannel = (guild) => {
        if (!guild) return null;
        const id = config.logs.miscChannelId;
        if (!id) return null;
        const ch = guild.channels.cache.get(id);
        return (ch && ch.isTextBased()) ? ch : null;
    };

    const getEmbedColor = () => (typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color) || 0x6e19e6;

    // Rollenwijzigingen + nickname wijzigingen
    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        try {
            const guild = newMember.guild;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;
            if (newMember.user?.bot) return;

            const color = getEmbedColor();

            // Rollen diff
            const oldRoles = new Set(oldMember.roles.cache.keys());
            const newRoles = new Set(newMember.roles.cache.keys());
            const everyoneId = guild.roles.everyone.id;

            const added = [...newRoles].filter(id => !oldRoles.has(id) && id !== everyoneId);
            const removed = [...oldRoles].filter(id => !newRoles.has(id) && id !== everyoneId);

            if (added.length || removed.length) {
                let moderator = null;
                try {
                    // MemberRoleUpdate = 25
                    const fetched = await guild.fetchAuditLogs({ type: 25, limit: 5 });
                    const entry = fetched.entries.find(e =>
                        e?.target?.id === newMember.id &&
                        (Date.now() - e.createdTimestamp) < 5000
                    );
                    moderator = entry?.executor || null;
                } catch (e) {
                    console.warn('[MiscLogs] Kan audit log niet ophalen voor rollen update:', e.message || e);
                }

                const lines = [
                    `**Gebruiker:**\n> <@${newMember.id}> (${newMember.user?.tag || 'Onbekend'})`,
                    `**Toegevoegd:**\n> ${added.length ? added.map(r => `<@&${r}>`).join(', ') : '—'}`,
                    `**Verwijderd:**\n> ${removed.length ? removed.map(r => `<@&${r}>`).join(', ') : '—'}`
                ];
                if (moderator) lines.push(`**Aangepast door:**\n> <@${moderator.id}> (${moderator.tag || moderator.username})`);

                await logChannel.send({
                    embeds: [{
                        title: '🛡️ Rollen bijgewerkt',
                        description: lines.join('\n'),
                        color,
                        timestamp: new Date().toISOString(),
                        thumbnail: {
                            url: (newMember.user?.displayAvatarURL?.({ size: 128 }) || newMember.user?.avatarURL?.())
                        }
                    }]
                });
            }

            // Nickname change
            const oldNick = oldMember.nickname || oldMember.user?.username || 'Geen';
            const newNick = newMember.nickname || newMember.user?.username || 'Geen';
            if (oldNick !== newNick) {
                let nickModerator = null;
                try {
                    // MemberUpdate = 24
                    const fetched = await guild.fetchAuditLogs({ type: 24, limit: 5 });
                    const entry = fetched.entries.find(e =>
                        e?.target?.id === newMember.id &&
                        (Date.now() - e.createdTimestamp) < 5000 &&
                        e.changes?.some(c => c.key === 'nick')
                    );
                    nickModerator = entry?.executor || null;
                } catch (e) {
                    console.warn('[MiscLogs] Kan audit log niet ophalen voor nickname update:', e.message || e);
                }

                const isSelf = nickModerator && nickModerator.id === newMember.id;
                const changedByLine = nickModerator
                    ? `**Gewijzigd door:**\n> ${isSelf ? 'Zelf' : `<@${nickModerator.id}> (${nickModerator.tag || nickModerator.username})`}`
                    : null;

                const nickLines = [
                    `**Gebruiker:**\n> <@${newMember.id}> (${newMember.user?.tag || 'Onbekend'})`,
                    `**Oud:**\n> ${oldNick}`,
                    `**Nieuw:**\n> ${newNick}`,
                    changedByLine
                ].filter(Boolean);

                await logChannel.send({
                    embeds: [{
                        title: '✏️ Nickname gewijzigd',
                        description: nickLines.join('\n'),
                        color,
                        timestamp: new Date().toISOString()
                    }]
                });
            }
        } catch (err) {
            console.error('[MiscLogs] Fout bij guildMemberUpdate log:', err);
        }
    });

    // Globale gebruikersnaam wijzigingen (userUpdate heeft geen guild context)
    client.on('userUpdate', async (oldUser, newUser) => {
        try {
            if (newUser?.bot) return;
            if (oldUser.username === newUser.username) return;

            const gid = process.env.GUILD_ID;
            const guild = gid ? client.guilds.cache.get(gid) : null;
            if (!guild) return;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            await logChannel.send({
                embeds: [{
                    title: '✏️ Gebruikersnaam gewijzigd',
                    description: [
                        `**Gebruiker:**\n> <@${newUser.id}> (${newUser.tag || newUser.username})`,
                        `**Oud:**\n> ${oldUser.username || 'Onbekend'}`,
                        `**Nieuw:**\n> ${newUser.username || 'Onbekend'}`
                    ].join('\n'),
                    color: getEmbedColor(),
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (err) {
            console.error('[MiscLogs] Fout bij userUpdate log:', err);
        }
    });

    // Kanaal aangemaakt
    client.on('channelCreate', async (channel) => {
        try {
            const guild = channel?.guild;
            if (!guild) return;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            let moderator = null;
            try {
                // ChannelCreate = 10
                const fetched = await guild.fetchAuditLogs({ type: 10, limit: 5 });
                const entry = fetched.entries.find(e =>
                    e?.target?.id === channel.id &&
                    (Date.now() - e.createdTimestamp) < 5000
                );
                moderator = entry?.executor || null;
            } catch (e) {
                console.warn('[MiscLogs] Kan audit log niet ophalen voor channelCreate:', e.message || e);
            }

            const lines = [
                `**Kanaal:**\n> ${channel.isTextBased() ? `<#${channel.id}>` : `#${channel.name || channel.id}`}`,
                `**Type:**\n> ${String(channel.type)}`,
                channel.parentId ? `**Categorie:**\n> <#${channel.parentId}>` : null,
                moderator ? `**Aangemaakt door:**\n> <@${moderator.id}> (${moderator.tag || moderator.username})` : null
            ].filter(Boolean);

            await logChannel.send({
                embeds: [{
                    title: '📁 Kanaal aangemaakt',
                    description: lines.join('\n'),
                    color: getEmbedColor(),
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (err) {
            console.error('[MiscLogs] Fout bij channelCreate log:', err);
        }
    });

    // Kanaal naam gewijzigd
    client.on('channelUpdate', async (oldChannel, newChannel) => {
        try {
            const guild = newChannel?.guild || oldChannel?.guild;
            if (!guild) return;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            const oldName = oldChannel?.name;
            const newName = newChannel?.name;
            if (!oldName || !newName || oldName === newName) return;

            let moderator = null;
            try {
                // ChannelUpdate = 11
                const fetched = await guild.fetchAuditLogs({ type: 11, limit: 5 });
                const entry = fetched.entries.find(e =>
                    e?.target?.id === newChannel.id &&
                    (Date.now() - e.createdTimestamp) < 5000
                );
                moderator = entry?.executor || null;
            } catch (e) {
                console.warn('[MiscLogs] Kan audit log niet ophalen voor channelUpdate:', e.message || e);
            }

            const lines = [
                `**Kanaal:**\n> ${newChannel.isTextBased() ? `<#${newChannel.id}>` : `#${newName || newChannel.id}`}`,
                `**Oud:**\n> ${oldName}`,
                `**Nieuw:**\n> ${newName}`,
                `**Type:**\n> ${String(newChannel.type)}`,
                newChannel.parentId ? `**Categorie:**\n> <#${newChannel.parentId}>` : null,
                moderator ? `**Gewijzigd door:**\n> <@${moderator.id}> (${moderator.tag || moderator.username})` : null
            ].filter(Boolean);

            await logChannel.send({
                embeds: [{
                    title: '✏️ Kanaalnaam gewijzigd',
                    description: lines.join('\n'),
                    color: getEmbedColor(),
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (err) {
            console.error('[MiscLogs] Fout bij channelUpdate log:', err);
        }
    });

    // Kanaal verwijderd
    client.on('channelDelete', async (channel) => {
        try {
            const guild = channel?.guild;
            if (!guild) return;
            const logChannel = getLogChannel(guild);
            if (!logChannel) return;

            let moderator = null;
            try {
                // ChannelDelete = 12
                const fetched = await guild.fetchAuditLogs({ type: 12, limit: 5 });
                const entry = fetched.entries.find(e =>
                    e?.target?.id === channel.id &&
                    (Date.now() - e.createdTimestamp) < 5000
                );
                moderator = entry?.executor || null;
            } catch (e) {
                console.warn('[MiscLogs] Kan audit log niet ophalen voor channelDelete:', e.message || e);
            }

            const lines = [
                `**Kanaal:**\n> #${channel.name || channel.id}`,
                `**Type:**\n> ${String(channel.type)}`,
                channel.parentId ? `**Categorie:**\n> <#${channel.parentId}>` : null,
                moderator ? `**Verwijderd door:**\n> <@${moderator.id}> (${moderator.tag || moderator.username})` : null
            ].filter(Boolean);

            await logChannel.send({
                embeds: [{
                    title: '🗑️ Kanaal verwijderd',
                    description: lines.join('\n'),
                    color: 0xFF0000,
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (err) {
            console.error('[MiscLogs] Fout bij channelDelete log:', err);
        }
    });
};