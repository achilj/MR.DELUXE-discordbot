const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ComponentType
} = require('discord.js');
const config = require('../../config.js');

// Gemeenschappelijke permissie-check
function checkPerms(interaction) {
    const member = interaction.member;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    return isAdmin;
}

// Button handler gedeeld door alle giveaway-* commando's
async function handleGiveawayButton(interaction, pool) {
    if (interaction.customId !== 'giveaway-join') return false;

    const [rows] = await pool.query(
        'SELECT * FROM giveaway WHERE message_id = ? AND ended = 0',
        [interaction.message.id]
    );
    if (!rows.length) {
        const errorEmbed = new EmbedBuilder()
            .setDescription('Deze giveaway is niet (meer) actief.')
            .setColor(0xED4245);
        await interaction.reply({ embeds: [errorEmbed], flags: 64 });
        return true;
    }
    const giveaway = rows[0];

    try {
        await pool.query(
            'INSERT INTO giveaway_entry (giveaway_id, user_id) VALUES (?, ?)',
            [giveaway.id, interaction.user.id]
        );
        const [entries] = await pool.query(
            'SELECT COUNT(*) AS count FROM giveaway_entry WHERE giveaway_id = ?',
            [giveaway.id]
        );
        const deelnemers = entries[0].count;
        const embed = EmbedBuilder.from(interaction.message.embeds[0]);
        let desc = embed.data.description || '';
        desc = desc.replace(/\*\*Aantal deelnemers:\*\* \d+/, `**Aantal deelnemers:** ${deelnemers}`);
        embed.setDescription(desc);
        await interaction.message.edit({ embeds: [embed] });
        const successEmbed = new EmbedBuilder()
            .setDescription('Je doet mee aan de giveaway!')
            .setColor(0x43b581);
        await interaction.reply({ embeds: [successEmbed], flags: 64 });
    } catch (err) {
        const errorEmbed = new EmbedBuilder()
            .setDescription('Je doet al mee aan deze giveaway!')
            .setColor(0xED4245);
        await interaction.reply({ embeds: [errorEmbed], flags: 64 });
    }
    return true;
}

// Hoofdcommando /giveaway met subcommando's (en groep voor "nieuwe winnaar")
const data = new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Beheer giveaways (alleen voor moderators/admins)')
    .addSubcommand(sub =>
        sub.setName('start')
            .setDescription('Start een nieuwe giveaway')
            .addStringOption(option =>
                option.setName('prijs')
                    .setDescription('Wat is de prijs?')
                    .setRequired(true)
            )
            .addIntegerOption(option =>
                option.setName('winnaars')
                    .setDescription('Aantal winnaars')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(20)
            )
            .addIntegerOption(option =>
                option.setName('dagen')
                    .setDescription('Aantal dagen dat de giveaway duurt')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(30)
            )
    )
    .addSubcommand(sub =>
        sub.setName('end')
            .setDescription('Stop een actieve giveaway')
            .addStringOption(option =>
                option.setName('berichtid')
                    .setDescription('Het bericht-ID van de giveaway')
                    .setRequired(true)
            )
    )
    .addSubcommandGroup(group =>
        group.setName('nieuwe')
            .setDescription('Nieuwe acties')
            .addSubcommand(sub =>
                sub.setName('winnaar')
                    .setDescription('Kies een nieuwe winnaar voor een afgelopen giveaway')
                    .addStringOption(option =>
                        option.setName('berichtid')
                            .setDescription('Het bericht-ID van de giveaway')
                            .setRequired(true)
                    )
            )
    )
    .addSubcommand(sub =>
        sub.setName('bewerken')
            .setDescription('Bewerk een actieve giveaway')
            .addStringOption(option =>
                option.setName('berichtid')
                    .setDescription('Het bericht-ID van de giveaway')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option.setName('prijs')
                    .setDescription('Nieuwe prijs (optioneel)')
                    .setRequired(false)
            )
            .addIntegerOption(option =>
                option.setName('winnaars')
                    .setDescription('Nieuw aantal winnaars (optioneel)')
                    .setRequired(false)
                    .setMinValue(1)
                    .setMaxValue(20)
            )
            .addIntegerOption(option =>
                option.setName('dagen')
                    .setDescription('Verleng/verkort in dagen (optioneel)')
                    .setRequired(false)
                    .setMinValue(1)
                    .setMaxValue(30)
            )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction, pool) {
    if (!checkPerms(interaction)) {
        const errorEmbed = new EmbedBuilder()
            .setDescription('Je hebt geen toestemming om dit commando te gebruiken.')
            .setColor(0xED4245);
        return interaction.reply({ embeds: [errorEmbed], flags: 64 });
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    // /giveaway start
    if (!group && sub === 'start') {
        const prijs = interaction.options.getString('prijs');
        const winnaars = interaction.options.getInteger('winnaars');
        const dagen = interaction.options.getInteger('dagen');
        const eindDatum = new Date(Date.now() + dagen * 24 * 60 * 60 * 1000);
        const eindTimestamp = Math.floor(eindDatum.getTime() / 1000);
        const deelnemers = 0;
        const embed = new EmbedBuilder()
            .setTitle('🎉 Giveaway!')
            .setDescription([
                `**Prijs:** ${prijs}`,
                `**Aantal winnaars:** ${winnaars}`,
                `**Eindigt:** <t:${eindTimestamp}:F>`,
                `**Aantal deelnemers:** ${deelnemers}`,
                '',
                'Klik op **Deelnemen** om kans te maken!'
            ].join('\n'))
            .setColor(config.general.color)
            .setFooter({ text: `Giveaway gestart door ${interaction.user.tag}` });
        const joinBtn = new ButtonBuilder()
            .setCustomId('giveaway-join')
            .setLabel('Deelnemen')
            .setStyle(ButtonStyle.Success);
        const row = new ActionRowBuilder().addComponents(joinBtn);
        await interaction.reply({ embeds: [embed], components: [row] });
        const msg = await interaction.fetchReply();
        await pool.query(
            'INSERT INTO giveaway (message_id, channel_id, prize, winners, end_time) VALUES (?, ?, ?, ?, ?)',
            [msg.id, msg.channel.id, prijs, winnaars, eindDatum]
        );
        return;
    }

    // /giveaway end
    if (!group && sub === 'end') {
        const berichtId = interaction.options.getString('berichtid');
        const [rows] = await pool.query(
            'SELECT * FROM giveaway WHERE message_id = ? AND ended = 0',
            [berichtId]
        );
        if (!rows.length) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Geen actieve giveaway gevonden met dat bericht-ID.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const giveaway = rows[0];
        const [entries] = await pool.query(
            'SELECT user_id FROM giveaway_entry WHERE giveaway_id = ?',
            [giveaway.id]
        );
        let winners = [];
        if (entries.length > 0) {
            const shuffled = entries.map(e => e.user_id).sort(() => 0.5 - Math.random());
            winners = shuffled.slice(0, giveaway.winners);
        }
        await pool.query('UPDATE giveaway SET ended = 1 WHERE id = ?', [giveaway.id]);
        try {
            const channel = await interaction.client.channels.fetch(giveaway.channel_id);
            const message = await channel.messages.fetch(giveaway.message_id);
            const embed = EmbedBuilder.from(message.embeds[0]);
            embed.setDescription((embed.data.description || '') + '\n\n**Giveaway handmatig beëindigd.**');
            await message.edit({ embeds: [embed], components: [] });
        } catch (e) {
            // Kan bericht niet aanpassen
        }
        const channel = await interaction.client.channels.fetch(giveaway.channel_id);
        if (winners.length > 0) {
            if (winners.length === 1) {
                const winnerEmbed = new EmbedBuilder()
                    .setTitle(`🎉 Winnaar: ${giveaway.prize}`)
                    .setDescription(`Gefeliciteerd <@${winners[0]}>, veel plezier met je **${giveaway.prize}**!`)
                    .setColor(0x43b581);
                await channel.send({ content: `<@${winners[0]}>`, embeds: [winnerEmbed] });
            } else {
                const winnerEmbed = new EmbedBuilder()
                    .setTitle(`🎉 ${giveaway.prize}`)
                    .setDescription(`Gefeliciteerd ${winners.map(id => `<@${id}>`).join(', ')}\nVeel plezier met jullie **${giveaway.prize}**!`)
                    .setColor(0x43b581);
                await channel.send({ content: winners.map(id => `<@${id}>`).join(' '), embeds: [winnerEmbed] });
            }
        } else {
            const noWinnerEmbed = new EmbedBuilder()
                .setTitle('🎉 Giveaway beëindigd!')
                .setDescription('Er waren geen deelnemers aan deze giveaway.')
                .setColor(0xED4245);
            await channel.send({ embeds: [noWinnerEmbed] });
        }
        const successEmbed = new EmbedBuilder()
            .setDescription('Giveaway is beëindigd.')
            .setColor(0x43b581);
        return interaction.reply({ embeds: [successEmbed], flags: 64 });
    }

    // /giveaway nieuwe winnaar
    if (group === 'nieuwe' && sub === 'winnaar') {
        const berichtId = interaction.options.getString('berichtid');
        const [rows] = await pool.query(
            'SELECT * FROM giveaway WHERE message_id = ?',
            [berichtId]
        );
        if (!rows.length) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Geen giveaway gevonden met dat bericht-ID.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const giveaway = rows[0];
        if (giveaway.ended === 0) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Deze giveaway is nog actief. Je kunt pas een nieuwe winnaar kiezen als de giveaway is afgelopen.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const [entries] = await pool.query(
            'SELECT user_id FROM giveaway_entry WHERE giveaway_id = ?',
            [giveaway.id]
        );
        if (entries.length === 0) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Er zijn geen deelnemers aan deze giveaway.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const shuffled = entries.map(e => e.user_id).sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, giveaway.winners);
        const channel = await interaction.client.channels.fetch(giveaway.channel_id);
        if (winners.length === 1) {
            const winnerEmbed = new EmbedBuilder()
                .setTitle(`🎉 Nieuwe winnaar: ${giveaway.prize}`)
                .setDescription(`Gefeliciteerd <@${winners[0]}>, veel plezier met je **${giveaway.prize}**!`)
                .setColor(0x43b581);
            await channel.send({ content: `<@${winners[0]}>`, embeds: [winnerEmbed] });
            const successEmbed = new EmbedBuilder()
                .setDescription(`Nieuwe winnaar geselecteerd: <@${winners[0]}>`)
                .setColor(0x43b581);
            return interaction.reply({ embeds: [successEmbed], flags: 64 });
        } else {
            const winnerEmbed = new EmbedBuilder()
                .setTitle(`🎉 ${giveaway.prize}`)
                .setDescription(`Gefeliciteerd ${winners.map(id => `<@${id}>`).join(', ')}\nVeel plezier met jullie **${giveaway.prize}**!`)
                .setColor(0x43b581);
            await channel.send({ content: winners.map(id => `<@${id}>`).join(' '), embeds: [winnerEmbed] });
            const successEmbed = new EmbedBuilder()
                .setDescription(`Nieuwe winnaars geselecteerd: ${winners.map(id => `<@${id}>`).join(', ')}`)
                .setColor(0x43b581);
            return interaction.reply({ embeds: [successEmbed], flags: 64 });
        }
    }

    // /giveaway bewerken
    if (!group && sub === 'bewerken') {
        const berichtIdBewerk = interaction.options.getString('berichtid');
        const nieuwePrijs = interaction.options.getString('prijs');
        const nieuweWinnaars = interaction.options.getInteger('winnaars');
        const nieuweDagen = interaction.options.getInteger('dagen');
        if (!nieuwePrijs && !nieuweWinnaars && !nieuweDagen) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Je moet minstens één veld (prijs, winnaars of dagen) opgeven om te bewerken.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const [rowsBewerk] = await pool.query(
            'SELECT * FROM giveaway WHERE message_id = ? AND ended = 0',
            [berichtIdBewerk]
        );
        if (!rowsBewerk.length) {
            const errorEmbed = new EmbedBuilder()
                .setDescription('Geen actieve giveaway gevonden met dat bericht-ID.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [errorEmbed], flags: 64 });
        }
        const giveawayBewerk = rowsBewerk[0];
        const updateFields = [];
        const updateValues = [];
        if (nieuwePrijs) {
            updateFields.push('prize = ?');
            updateValues.push(nieuwePrijs);
        }
        if (nieuweWinnaars) {
            updateFields.push('winners = ?');
            updateValues.push(nieuweWinnaars);
        }
        if (nieuweDagen) {
            const nieuweEindDatum = new Date(Date.now() + nieuweDagen * 24 * 60 * 60 * 1000);
            updateFields.push('end_time = ?');
            updateValues.push(nieuweEindDatum);
        }
        updateValues.push(giveawayBewerk.id);
        await pool.query(
            `UPDATE giveaway SET ${updateFields.join(', ')} WHERE id = ?`,
            updateValues
        );
        try {
            const channel = await interaction.client.channels.fetch(giveawayBewerk.channel_id);
            const message = await channel.messages.fetch(giveawayBewerk.message_id);
            const embed = EmbedBuilder.from(message.embeds[0]);
            let desc = embed.data.description || '';
            if (nieuwePrijs) {
                desc = desc.replace(/\*\*Prijs:\*\* .*/, `**Prijs:** ${nieuwePrijs}`);
            }
            if (nieuweWinnaars) {
                desc = desc.replace(/\*\*Aantal winnaars:\*\* .*/, `**Aantal winnaars:** ${nieuweWinnaars}`);
            }
            if (nieuweDagen) {
                const nieuweEindDatum = new Date(Date.now() + nieuweDagen * 24 * 60 * 60 * 1000);
                const nieuweEindTimestamp = Math.floor(nieuweEindDatum.getTime() / 1000);
                desc = desc.replace(/\*\*Eindigt:\*\* <t:[^>]+:F>/, `**Eindigt:** <t:${nieuweEindTimestamp}:F>`);
            }
            embed.setDescription(desc);
            await message.edit({ embeds: [embed] });
        } catch (e) {
            // Kan bericht niet aanpassen
        }
        const successEmbed = new EmbedBuilder()
            .setDescription('Giveaway succesvol bijgewerkt.')
            .setColor(0x43b581);
        return interaction.reply({ embeds: [successEmbed], flags: 64 });
    }
}

module.exports = {
    data,
    execute,
    handleButton: handleGiveawayButton
};