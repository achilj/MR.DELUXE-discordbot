const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require('discord.js');
const config = require('../../config.js');

const WARN_LOG_CHANNEL_ID = config.logs.moderation.warnChannelId;
const EMBED_COLOR = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Waarschuw een gebruiker, bekijk of verwijder waarschuwingen (alleen voor moderators/admins)')
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Voeg een waarschuwing toe aan een gebruiker')
                .addUserOption(option =>
                    option
                        .setName('gebruiker')
                        .setDescription('Selecteer een gebruiker of vul een user ID in')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('reden')
                        .setDescription('Reden voor de waarschuwing')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('check')
                .setDescription('Bekijk de waarschuwingen van een gebruiker')
                .addUserOption(option =>
                    option
                        .setName('gebruiker')
                        .setDescription('Selecteer een gebruiker of vul een user ID in')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('clear')
                .setDescription('Verwijder alle waarschuwingen van een gebruiker')
                .addUserOption(option =>
                    option
                        .setName('gebruiker')
                        .setDescription('Selecteer een gebruiker of vul een user ID in')
                        .setRequired(true)
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    async execute(interaction, pool) {
        // Check of waarschuwingensysteem is ingeschakeld
        if (!config.features.warnSystem) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Waarschuwingssysteem uitgeschakeld')
                .setDescription('Het waarschuwingssysteem is uitgeschakeld.')
                .setColor(0xFF0000);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }

        const actie = interaction.options.getSubcommand();
        const targetUser = interaction.options.getUser('gebruiker');
        const member = interaction.member;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
        const isModerator = member.roles.cache.has(config.roles.moderatorId);

        if (!isAdmin && !isModerator) {
            return interaction.reply({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 });
        }

        if (!targetUser) {
            return interaction.reply({ content: 'Gebruiker niet gevonden.', flags: 64 });
        }

    // Check of targetUser admin/mod is
        const guildMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (guildMember) {
            const isTargetAdmin = guildMember.permissions.has(PermissionFlagsBits.Administrator);
            const isTargetModerator = guildMember.roles.cache.has(config.roles.moderatorId);
            if (isTargetAdmin || isTargetModerator) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Actie niet toegestaan')
                    .setDescription('Je kunt geen moderators of admins waarschuwen.')
                    .setColor(0xFF0000);
                return interaction.reply({ embeds: [errorEmbed], flags: 64 });
            }
        }

        const warnTargetAvatar = targetUser.displayAvatarURL({ size: 256 });

    // Logfunctie
        async function logWarn(embed) {
            try {
                const guild = interaction.guild;
                const logChannel = guild.channels.cache.get(WARN_LOG_CHANNEL_ID);
                if (logChannel && logChannel.isTextBased()) {
                    await logChannel.send({ embeds: [embed] });
                }
            } catch (err) {
                console.error('[WarnLog] Fout bij loggen:', err);
            }
        }

        if (actie === 'add') {
            const reden = interaction.options.getString('reden');
            if (!reden || reden.trim() === '') {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Geen reden opgegeven')
                    .setDescription('Geef een reden op voor de waarschuwing.')
                    .setColor(0xFF0000);
                return interaction.reply({ embeds: [errorEmbed], flags: 64 });
            }
            // Voeg waarschuwing toe
            try {
                await pool.query(
                    'INSERT INTO warn (userid, reason, date) VALUES (?, ?, NOW())',
                    [targetUser.id, reden]
                );
                // Haal totaal aantal waarschuwingen op
                const [rows] = await pool.query(
                    'SELECT COUNT(*) as aantal FROM warn WHERE userid = ?',
                    [targetUser.id]
                );
                const aantal = rows[0]?.aantal || 1;

                // DM naar gebruiker
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setTitle(`⚠️ Je hebt een waarschuwing ontvangen in ${interaction.guild.name}`)
                        .setDescription(`**Reden:** ${reden}\n**Aantal waarschuwingen:** ${aantal}`)
                        .setColor(config.general.color);
                    await targetUser.send({ embeds: [dmEmbed] });
                } catch {
                    // DM niet gelukt
                }

                // Log naar kanaal
                const logEmbed = new EmbedBuilder()
                    .setTitle('✅ Waarschuwing toegevoegd')
                    .setDescription([
                        `**Gebruiker:** <@${targetUser.id}> (${targetUser.tag})`,
                        `**Moderator:** <@${interaction.user.id}> (${interaction.user.tag})`,
                        `**Reden:** ${reden}`,
                        `**Aantal waarschuwingen:** ${aantal}`
                    ].join('\n'))
                    .setThumbnail(warnTargetAvatar)
                    .setColor(0x43b581)
                    .setTimestamp(new Date());
                await logWarn(logEmbed);

                // Antwoord naar moderator
                const replyEmbed = new EmbedBuilder()
                    .setTitle('✅ Waarschuwing toegevoegd')
                    .setDescription(`<@${targetUser.id}> heeft een waarschuwing gekregen.\n**Reden:** ${reden}\n**Aantal waarschuwingen:** ${aantal}`)
                    .setColor(0x43b581);
                return interaction.reply({ embeds: [replyEmbed], flags: 64 });
            } catch (err) {
                console.error('Fout bij toevoegen van waarschuwing:', err);
                return interaction.reply({ content: 'Fout bij toevoegen van waarschuwing.', flags: 64 });
            }
        }

        if (actie === 'check') {
            // Haal waarschuwingen op
            try {
                const [rows] = await pool.query(
                    'SELECT * FROM warn WHERE userid = ? ORDER BY date DESC',
                    [targetUser.id]
                );
                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('Geen waarschuwingen gevonden')
                        .setDescription(`<@${targetUser.id}> heeft geen waarschuwingen.`)
                        .setColor(EMBED_COLOR);
                    return interaction.reply({ embeds: [embed], flags: 64 });
                }
                // Toon alle waarschuwingen
                const warnsList = rows.map((row, i) =>
                    `**${i + 1}.** ${row.reason} _(op ${row.date.toLocaleString('nl-NL')})_`
                ).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle(`Waarschuwingen voor ${targetUser.tag}`)
                    .setDescription(warnsList)
                    .setColor(EMBED_COLOR)
                    .setFooter({ text: `Totaal: ${rows.length}` });
                return interaction.reply({ embeds: [embed], flags: 64 });
            } catch (err) {
                console.error('Fout bij ophalen van waarschuwingen:', err);
                return interaction.reply({ content: 'Fout bij ophalen van waarschuwingen.', flags: 64 });
            }
        }

        if (actie === 'clear') {
            // Verwijder alle waarschuwingen
            try {
                const [rows] = await pool.query(
                    'SELECT * FROM warn WHERE userid = ?',
                    [targetUser.id]
                );
                if (rows.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('Geen waarschuwingen gevonden')
                        .setDescription(`<@${targetUser.id}> heeft geen waarschuwingen om te verwijderen.`)
                        .setColor(EMBED_COLOR);
                    return interaction.reply({ embeds: [embed], flags: 64 });
                }
                await pool.query(
                    'DELETE FROM warn WHERE userid = ?',
                    [targetUser.id]
                );
                // Log naar kanaal
                const logEmbed = new EmbedBuilder()
                    .setTitle('❌ Waarschuwingen verwijderd')
                    .setDescription([
                        `**Gebruiker:** <@${targetUser.id}> (${targetUser.tag})`,
                        `**Moderator:** <@${interaction.user.id}> (${interaction.user.tag})`,
                        `**Aantal verwijderde waarschuwingen:** ${rows.length}`
                    ].join('\n'))
                    .setThumbnail(warnTargetAvatar)
                    .setColor(0xFF0000)
                    .setTimestamp(new Date());
                await logWarn(logEmbed);

                // Antwoord naar moderator
                const replyEmbed = new EmbedBuilder()
                    .setTitle('❌ Waarschuwingen verwijderd')
                    .setDescription(`Alle waarschuwingen van <@${targetUser.id}> zijn verwijderd.`)
                    .setColor(0xFF0000);
                return interaction.reply({ embeds: [replyEmbed], flags: 64 });
            } catch (err) {
                console.error('Fout bij verwijderen van waarschuwingen:', err);
                return interaction.reply({ content: 'Fout bij verwijderen van waarschuwingen.', flags: 64 });
            }
        }
    }
};