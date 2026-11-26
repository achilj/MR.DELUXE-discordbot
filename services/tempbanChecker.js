module.exports = function startTempbanChecker(client, pool, config) {
    client.once('clientReady', () => {
        setInterval(async () => {
            try {
                const [rows] = await pool.query(
                    'SELECT userid, expiration_date FROM tempban WHERE expiration_date <= current_timestamp()'
                );
                if (!rows.length) return;

                const guild = client.guilds.cache.get(process.env.GUILD_ID);
                if (!guild) {
                    console.warn('[Tempban] Kan guild niet vinden. Sla deze ronde over.');
                    return;
                }

                const logChannelId = config.logs.moderation.unbanChannelId;
                let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;

                let logChannel = null;
                if (logChannelId) {
                    logChannel = guild.channels.cache.get(logChannelId);
                }

                let unbanned = [];
                let failed = [];

                for (const row of rows) {
                    if (!/^\d{17,20}$/.test(row.userid)) {
                        console.error(`[Tempban] Ongeldige userid in DB, wordt niet ge-unbanned: ${row.userid}`);
                        failed.push({ id: row.userid, reason: 'Ongeldige userid' });
                        continue;
                    }
                    try {
                        await guild.members.unban(row.userid, 'Tempban verlopen');
                        unbanned.push(row.userid);

                        let user = null;
                        try {
                            user = await client.users.fetch(row.userid);
                        } catch (fetchErr) {
                            console.warn(`[Tempban] Kan gebruiker ${row.userid} niet ophalen:`, fetchErr.message);
                        }

                        if (logChannel && logChannel.isTextBased()) {
                            await logChannel.send({
                                embeds: [{
                                    title: '⏰ Tempban automatisch verlopen',
                                    description: [
                                        `**User ID:**\n> \`${row.userid}\``,
                                        `**Gebruiker:**\n> ${user ? `<@${user.id}> (${user.tag})` : 'Onbekend'}`,
                                        `**Verlopen op:**\n> <t:${Math.floor(new Date(row.expiration_date).getTime() / 1000)}:F>`
                                    ].join('\n'),
                                    color: embedColor,
                                    timestamp: new Date().toISOString()
                                }]
                            });
                        }
                    } catch (err) {
                        console.error(`[Tempban] Fout bij unbannen van ${row.userid}:`, err.message);
                        failed.push({ id: row.userid, reason: err.message });

                        if (logChannel && logChannel.isTextBased()) {
                            await logChannel.send({
                                embeds: [{
                                    title: '⚠️ Tempban unban mislukt',
                                    description: `Kon gebruiker met ID \`${row.userid}\` niet unbannen.`,
                                    color: 0xFF0000,
                                    fields: [
                                        { name: 'User ID', value: row.userid, inline: true },
                                        { name: 'Foutmelding', value: err.message, inline: true }
                                    ],
                                    timestamp: new Date().toISOString()
                                }]
                            });
                        }
                    }
                }

                await pool.query(
                    'DELETE FROM tempban WHERE expiration_date <= current_timestamp()'
                );

                if (unbanned.length > 0) {
                    console.log(`[Tempban] Ge-unbanned & uit DB verwijderd: ${unbanned.join(', ')}`);
                }
                if (failed.length > 0) {
                    console.log(`[Tempban] Niet ge-unbanned (maar wel uit DB): ${failed.map(f => `${f.id} (${f.reason})`).join(', ')}`);
                }
            } catch (err) {
                console.error('Fout bij automatisch unbannen van tempbans:', err);
            }
        }, 60 * 1000);
    });
};