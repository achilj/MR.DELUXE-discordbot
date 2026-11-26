const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = function registerWeekDiscord(client, config) {
    const embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
    const logChannelId = config.logs.alertChannelId;

    client.on('guildMemberAdd', async (member) => {
        try {
            if (!member || member.user?.bot) return;

            const createdTs = member.user?.createdTimestamp;
            if (!createdTs) return;

            const accountAgeMs = Date.now() - createdTs;
            if (accountAgeMs >= MIN_ACCOUNT_AGE_MS) return;

            const dmMessage = config.weekDiscordDmMessage
                || 'Je account is jonger dan een week. Accounts moeten minimaal een week oud zijn om deze server te betreden. Probeer het later opnieuw!';

            try {
                await member.send(dmMessage);
            } catch (err) {
                console.warn(`[WeekDiscord] DM naar ${member.user?.tag || member.id} mislukt: ${err?.message || err}`);
            }

            if (member.kickable) {
                await member.kick('Account jonger dan 7 dagen (minimumleeftijd vereist)');
            } else {
                console.warn(`[WeekDiscord] Kan ${member.user?.tag || member.id} niet kicken (kickable=false).`);
            }

            if (!logChannelId) return;
            const logChannel = member.guild.channels.cache.get(logChannelId);
            if (!logChannel?.isTextBased()) return;

            await logChannel.send({
                embeds: [{
                    title: '🚫 Jong account verwijderd',
                    description: [
                        `**Gebruiker:** <@${member.id}> (${member.user?.tag || member.user?.username || 'Onbekend'})`,
                        `**Account aangemaakt op:** <t:${Math.floor(createdTs / 1000)}:F>`,
                        '**Actie:** Kick wegens account jonger dan 7 dagen'
                    ].join('\n'),
                    color: embedColor,
                    timestamp: new Date().toISOString()
                }]
            });
        } catch (err) {
            console.error('[WeekDiscord] Fout bij afhandeling van nieuwe gebruiker:', err);
        }
    });
};