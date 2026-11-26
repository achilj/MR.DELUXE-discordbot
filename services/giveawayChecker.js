module.exports = function startGiveawayChecker(client, pool) {
    const { EmbedBuilder } = require('discord.js');
    client.once('clientReady', () => {
        setInterval(async () => {
            try {
                const [giveaways] = await pool.query(
                    'SELECT * FROM giveaway WHERE ended = 0 AND end_time <= NOW()'
                );
                for (const gw of giveaways) {
                    const [entries] = await pool.query(
                        'SELECT user_id FROM giveaway_entry WHERE giveaway_id = ?',
                        [gw.id]
                    );
                    if (entries.length === 0) {
                        await pool.query('UPDATE giveaway SET ended = 1 WHERE id = ?', [gw.id]);
                        const channel = client.channels.cache.get(gw.channel_id);
                        if (channel && channel.isTextBased()) {
                            const noEntryEmbed = new EmbedBuilder()
                                .setTitle('🎉 Giveaway geëindigd')
                                .setDescription(`Giveaway voor **${gw.prize}** is geëindigd, maar er waren geen deelnemers.`)
                                .setColor(0xFF0000);
                            await channel.send({ embeds: [noEntryEmbed] });
                            try {
                                const message = await channel.messages.fetch(gw.message_id);
                                const embed = EmbedBuilder.from(message.embeds[0]);
                                embed.setDescription((embed.data.description || '') + '\n\n**Giveaway beëindigd zonder winnaars.**');
                                await message.edit({ embeds: [embed], components: [] });
                            } catch (e) {}
                        }
                        continue;
                    }
                    const shuffled = entries.map(e => e.user_id).sort(() => 0.5 - Math.random());
                    const winners = shuffled.slice(0, gw.winners);
                    await pool.query('UPDATE giveaway SET ended = 1 WHERE id = ?', [gw.id]);
                    const channel = client.channels.cache.get(gw.channel_id);
                    if (channel && channel.isTextBased()) {
                        let winnerText = '';
                        if (winners.length === 1) {
                            winnerText = `Gefeliciteerd <@${winners[0]}>, veel plezier met je **${gw.prize}**!`;
                        } else {
                            winnerText = `Gefeliciteerd ${winners.map(id => `<@${id}>`).join(', ')}\nVeel plezier met jullie **${gw.prize}**!`;
                        }
                        const winnerEmbed = new EmbedBuilder()
                            .setTitle(`🎉 ${gw.prize}`)
                            .setDescription(winnerText)
                            .setColor(0x43b581);
                        await channel.send({
                            content: winners.map(id => `<@${id}>`).join(' '),
                            embeds: [winnerEmbed]
                        });
                        try {
                            const message = await channel.messages.fetch(gw.message_id);
                            const embed = EmbedBuilder.from(message.embeds[0]);
                            embed.setDescription((embed.data.description || '') + '\n\n**Giveaway is beëindigd.**');
                            await message.edit({ embeds: [embed], components: [] });
                        } catch (e) {}
                    }
                }
            } catch (err) {
                console.error('[Giveaway] Fout bij afhandelen verlopen giveaways:', err);
            }
        }, 60 * 1000);
    });
};