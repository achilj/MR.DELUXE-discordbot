const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder
} = require('discord.js');
const config = require('../../config.js');
const MODERATOR_ROLE_ID = config.roles.moderatorId;
const EMBED_COLOR = config.general.color;

const getAvatarUrl = (user) => {
    try {
        if (!user) return null;
        return user.displayAvatarURL({ extension: 'png', size: 128 }) || null;
    } catch {
        return null;
    }
};

module.exports = {
    commands: [
        // TEMPBAN
    {
            data: new SlashCommandBuilder()
                .setName('tempban')
                .setDescription('Ban een gebruiker tijdelijk (alleen voor moderators/admins)')
                .addUserOption(option =>
                    option.setName('gebruiker')
                        .setDescription('De gebruiker die je tijdelijk wilt bannen')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('reden')
                        .setDescription('Reden voor de tijdelijke ban (optioneel: als je dit invult, verschijnt er geen pop‑up).')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option.setName('uren')
                        .setDescription('Aantal uren voor de ban')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option.setName('dagen')
                        .setDescription('Aantal dagen voor de ban')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option.setName('maanden')
                        .setDescription('Aantal maanden voor de ban')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option.setName('jaren')
                        .setDescription('Aantal jaren voor de ban')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option.setName('verwijder_berichten')
                        .setDescription('Welke berichten van de gebruiker moeten verwijderd worden?')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Verwijder geen berichten', value: '0' },
                            { name: 'Afgelopen uur', value: '3600' },
                            { name: 'Afgelopen 6 uur', value: '21600' },
                            { name: 'Afgelopen 12 uur', value: '43200' },
                            { name: 'Afgelopen 24 uur', value: '86400' },
                            { name: 'Afgelopen 3 dagen', value: '259200' },
                            { name: 'Afgelopen 7 dagen', value: '604800' }
                        )
                )
                .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

            async execute(interaction, pool) {
                const member = interaction.member;
                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                const isModerator = member.roles.cache.has(MODERATOR_ROLE_ID);
                if (!isAdmin && !isModerator)
                    return interaction.reply({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 });

                let targetUser = interaction.options.getUser('gebruiker');
                if (!targetUser) return interaction.reply({ content: 'Gebruiker niet gevonden.', flags: 64 });

                let targetMember;
                try { targetMember = await interaction.guild.members.fetch(targetUser.id); } catch { targetMember = null; }
                if (targetMember) {
                    const isTargetAdmin = targetMember.permissions.has(PermissionFlagsBits.Administrator);
                    const isTargetModerator = targetMember.roles.cache.has(MODERATOR_ROLE_ID);
                    if (isTargetAdmin || isTargetModerator) {
                        const embed = new EmbedBuilder()
                            .setTitle('Kan gebruiker niet tempbannen')
                            .setDescription('Je kunt geen administrator of moderator tempbannen.')
                            .setColor(0xFF0000);
                        return interaction.reply({ embeds: [embed], flags: 64 });
                    }
                }

                const deleteMessageSeconds = Number(interaction.options.getString('verwijder_berichten') || 0);
                const opgegevenReden = interaction.options.getString('reden');
                const uren = interaction.options.getInteger('uren') || 0;
                const dagen = interaction.options.getInteger('dagen') || 0;
                const maanden = interaction.options.getInteger('maanden') || 0;
                const jaren = interaction.options.getInteger('jaren') || 0;
                if (uren + dagen + maanden + jaren === 0)
                    return interaction.reply({ content: 'Je moet minstens één tijdseenheid opgeven.', flags: 64 });

                const now = new Date();
                let vervalDatum = new Date(now);
                vervalDatum.setHours(vervalDatum.getHours() + uren);
                vervalDatum.setDate(vervalDatum.getDate() + dagen);
                vervalDatum.setMonth(vervalDatum.getMonth() + maanden);
                vervalDatum.setFullYear(vervalDatum.getFullYear() + jaren);
                const vervalTimestamp = Math.floor(vervalDatum.getTime() / 1000);

                const toMysqlDatetime = d => {
                    const pad = n => n.toString().padStart(2, '0');
                    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                };
                const vervalMysqlDatetime = toMysqlDatetime(vervalDatum);

                async function userHeeftAlTempban(userId) {
                    try {
                        const [rows] = await pool.query('SELECT * FROM tempban WHERE userid = ?', [userId]);
                        return rows.length > 0;
                    } catch (err) {
                        console.error('Databasefout bij tempban-check:', err);
                        return false;
                    }
                }

                async function voerTempbanUit(reason, respondFn) {
                    if (await userHeeftAlTempban(targetUser.id)) {
                        const embed = new EmbedBuilder()
                            .setTitle('Gebruiker heeft al een tempban')
                            .setDescription(`${targetUser.tag || targetUser.id} heeft al een actieve tempban.`)
                            .setColor(0xFF0000);
                        return respondFn({ embeds: [embed], flags: 64 });
                    }

                    try {
                        try {
                            const dmEmbed = new EmbedBuilder()
                                .setTitle(`Je bent tijdelijk verbannen van ${interaction.guild.name}`)
                                .setDescription(`**Reden:** ${reason}\n**Vervalt op:** <t:${vervalTimestamp}:F>`)
                                .setColor(EMBED_COLOR);
                            await targetUser.send({ embeds: [dmEmbed] });
                        } catch {
                            console.warn(`Kon geen DM sturen naar ${targetUser.tag}.`);
                        }

                        await interaction.guild.bans.create(targetUser.id, {
                            reason: `${reason} (door ${interaction.user.tag})`,
                            deleteMessageSeconds
                        });

                        await pool.query(
                            'INSERT INTO tempban (userid, expiration_date) VALUES (?, ?)',
                            [targetUser.id, vervalMysqlDatetime]
                        );

                        const embed = new EmbedBuilder()
                            .setTitle(`🛑 ${targetUser.tag || targetUser.id} tijdelijk verbannen`)
                            .setDescription(`**Reden:** ${reason}\n**Vervalt op:** <t:${vervalTimestamp}:F>`)
                            .setColor(EMBED_COLOR);
                        await respondFn({ embeds: [embed], flags: 64 });
                        try {
                            const logChannelId = config.logs.moderation.banChannelId;
                            let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
                            if (logChannelId) {
                                const guild = interaction.guild;
                                const logChannel = guild.channels.cache.get(logChannelId);
                                if (logChannel && logChannel.isTextBased()) {
                                    await logChannel.send({
                                        embeds: [{
                                            title: '⏰ Gebruiker tijdelijk verbannen',
                                            description: [
                                                `**User ID:**\n> \`${targetUser.id}\``,
                                                `**Gebruiker:**\n> <@${targetUser.id}> (${targetUser.tag})`,
                                                `**Verbannen door:**\n> <@${interaction.user.id}> (${interaction.user.tag})`,
                                                `**Reden:**\n> ${reason}`,
                                                `**Vervalt op:**\n> <t:${vervalTimestamp}:F>`
                                            ].join('\n'),
                                            color: embedColor,
                                            timestamp: new Date().toISOString(),
                                            thumbnail: { url: getAvatarUrl(targetUser) }
                                        }]
                                    });
                                }
                            }
                            // Meld aan Anti‑Nuke dat een ban is uitgevoerd via tempban (destructieve actie)
                            try {
                                interaction.client.emit('antiNuke:modAction', {
                                    guildId: interaction.guild.id,
                                    executorId: interaction.user.id,
                                    type: 'memberBan'
                                });
                            } catch {}
                        } catch (err) {
                            console.error('[TempbanLog] Fout bij loggen van tempban:', err);
                        }
                    } catch (err) {
                        console.error(err);
                        await respondFn({ content: 'Kon de gebruiker niet tijdelijk bannen.', flags: 64 });
                    }
                }

                if (opgegevenReden && opgegevenReden.trim() !== '') {
                    return voerTempbanUit(opgegevenReden, interaction.reply.bind(interaction));
                }

                const modal = new ModalBuilder()
                    .setCustomId(`tempban-modal-${targetUser.id}`)
                    .setTitle(`Tempban ${targetUser.tag}`)
                    .addComponents(new ActionRowBuilder().addComponents(
                        new TextInputBuilder({
                            custom_id: 'tempban-reason',
                            label: 'Reden voor tempban',
                            style: TextInputStyle.Paragraph,
                            required: true
                        })
                    ));
                await interaction.showModal(modal);

                const filter = i => i.customId === `tempban-modal-${targetUser.id}` && i.user.id === interaction.user.id;
                interaction.client.once('interactionCreate', async modalInteraction => {
                    if (!filter(modalInteraction)) return;
                    const reason = modalInteraction.fields.getTextInputValue('tempban-reason');
                    await voerTempbanUit(reason, modalInteraction.reply.bind(modalInteraction));
                });
            }
        },

        // REMOVE TEMPBAN COMMAND
        {
            data: new SlashCommandBuilder()
                .setName('removetempban')
                .setDescription('Verwijder een tijdelijke ban van een gebruiker (alleen voor moderators/admins)')
                .addUserOption(option =>
                    option.setName('gebruiker')
                        .setDescription('De gebruiker waarvan je de tempban wilt verwijderen')
                        .setRequired(true)
                )
                .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

            async execute(interaction, pool) {
                const member = interaction.member;
                const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                const isModerator = member.roles.cache.has(MODERATOR_ROLE_ID);

                if (!isAdmin && !isModerator) {
                    return interaction.reply({ content: 'Je hebt geen toestemming om dit commando te gebruiken.', flags: 64 });
                }

                const targetUser = interaction.options.getUser('gebruiker');
                if (!targetUser) {
                    return interaction.reply({ content: 'Gebruiker niet gevonden.', flags: 64 });
                }

                let tempbanRow;
                try {
                    const [rows] = await pool.query('SELECT * FROM tempban WHERE userid = ?', [targetUser.id]);
                    if (rows.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle('Geen actieve tempban')
                            .setDescription(`${targetUser.tag || targetUser.id} heeft geen actieve tempban.`)
                            .setColor(0xFF0000);
                        return interaction.reply({ embeds: [embed], flags: 64 });
                    }
                    tempbanRow = rows[0];
                } catch (err) {
                    console.error('Databasefout bij tempban-check:', err);
                    return interaction.reply({ content: 'Databasefout bij het controleren van de tijdelijke ban.', flags: 64 });
                }

                try {
                    await pool.query('DELETE FROM tempban WHERE userid = ?', [targetUser.id]);
                } catch (err) {
                    console.error('Kon tempban niet verwijderen uit de database:', err);
                    return interaction.reply({ content: 'Kon de tijdelijke ban niet verwijderen uit de database.', flags: 64 });
                }

                try {
                    await interaction.guild.bans.remove(targetUser.id, `Tempban verwijderd door ${interaction.user.tag}`);
                } catch (err) {
                    // negeer als niet geband
                }

                const embed = new EmbedBuilder()
                    .setTitle(`✅ Tempban verwijderd voor ${targetUser.tag || targetUser.id}`)
                    .setDescription('De gebruiker kan nu weer deelnemen aan de server.')
                    .setColor(EMBED_COLOR);

                // Log naar unbanLogChannelId indien ingesteld
                try {
                    const logChannelId = config.logs.moderation.unbanChannelId;
                    let embedColor = typeof config.general.color === 'string' ? parseInt(config.general.color, 16) : config.general.color;
                    if (logChannelId) {
                        const guild = interaction.guild;
                        const logChannel = guild.channels.cache.get(logChannelId);
                        if (logChannel && logChannel.isTextBased()) {
                            await logChannel.send({
                                embeds: [{
                                    title: '⏰ Tempban handmatig verwijderd',
                                    description: [
                                        `**User ID:**\n> \`${targetUser.id}\``,
                                        `**Gebruiker:**\n> <@${targetUser.id}> (${targetUser.tag})`,
                                        `**Verwijderd door:**\n> <@${interaction.user.id}> (${interaction.user.tag})`
                                    ].join('\n'),
                                    color: embedColor,
                                    timestamp: new Date().toISOString(),
                                    thumbnail: { url: getAvatarUrl(targetUser) }
                                }]
                            });
                        }
                    }
                    // Meld aan Anti‑Nuke dat een unban is uitgevoerd via remove tempban
                    try {
                        interaction.client.emit('antiNuke:modAction', {
                            guildId: interaction.guild.id,
                            executorId: interaction.user.id,
                            type: 'memberUnban'
                        });
                    } catch {}
                } catch (err) {
                    console.error('Kon niet loggen naar unbanLogChannelId:', err);
                }

                return interaction.reply({ embeds: [embed], flags: 64 });
            }
        }
    ]
};
