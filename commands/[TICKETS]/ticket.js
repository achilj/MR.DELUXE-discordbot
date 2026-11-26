const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    Events
} = require('discord.js');
const { createTranscript } = require('discord-html-transcripts');
const config = require('../../config.js');
const ticketMessages = require('../../ticketmessages.js');

const TICKET_CATEGORIES = {
    support: { label: 'Support', emoji: '🛟', description: 'Algemene ondersteuning' },
    aankopen: { label: 'Aankopen', emoji: '🛒', description: 'Vragen over aankopen' },
    unban: { label: 'Unban', emoji: '🔓', description: 'Unban aanvraag' },
    bugreport: { label: 'Bug Report', emoji: '🐛', description: 'Meld een bug' }
};

function isModOrAdmin(member) {
    return member.permissions.has(PermissionFlagsBits.Administrator) ||
        member.roles.cache.has(config.roles.moderatorId);
}

function sanitiseName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'user';
}

function buildTicketTopic(ownerId, username, categoryKey) {
    const categoryLabel = TICKET_CATEGORIES[categoryKey]?.label || categoryKey;
    const date = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
    return `🎫 Eigenaar: ${ownerId} (${username}) | Categorie: ${categoryLabel} | Aangemaakt: ${date}`;
}

function parseTicketMeta(channel) {
    if (!channel?.topic?.startsWith('🎫')) return null;
    try {
        const ownerMatch = channel.topic.match(/Eigenaar:\s*(\d+)\s*\(([^)]+)\)/);
        const categoryMatch = channel.topic.match(/Categorie:\s*([^|]+)/);
        if (!ownerMatch) return null;
        return {
            ownerId: ownerMatch[1],
            ownerName: ownerMatch[2].trim(),
            category: categoryMatch ? categoryMatch[1].trim() : 'Onbekend'
        };
    } catch {
        return null;
    }
}

function isTicketChannel(channel) {
    return Boolean(channel && channel.parentId === config.tickets.categoryId && channel.isTextBased());
}

async function createTicketChannel(interaction, categoryKey, meta) {
    const guild = interaction.guild;
    const channelName = `${categoryKey}-${sanitiseName(interaction.user.username)}`;
    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: config.tickets.categoryId,
        topic: buildTicketTopic(interaction.user.id, interaction.user.username, categoryKey),
        permissionOverwrites: [
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: interaction.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.AddReactions,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.ReadMessageHistory
                ]
            },
            ...(config.roles.moderatorId ? [{
                id: config.roles.moderatorId,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            }] : [])
        ],
        reason: `Ticket (${meta.label}) voor ${interaction.user.tag}`
    });

    // Haal het aangepaste bericht op voor dit tickettype
    const ticketMessage = ticketMessages[categoryKey] || {
        title: `🎟️ ${meta.label}`,
        description: 'Stel je vraag hier alvast. Het team reageert zo snel mogelijk.',
        color: 0x5865f2
    };

    const introEmbed = new EmbedBuilder()
        .setTitle(ticketMessage.title)
        .setDescription(ticketMessage.description)
        .setColor(ticketMessage.color);

    await channel.send({
        content: `<@${interaction.user.id}>`,
        embeds: [introEmbed],
        components: [buildCloseRow()]
    });

    return channel;
}

function buildCloseRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket-close')
            .setLabel('Ticket sluiten')
            .setStyle(ButtonStyle.Danger)
    );
}

async function promptClose(interaction) {
    const channel = interaction.channel;
    if (!isTicketChannel(channel)) {
        return interaction.reply({ content: 'Dit is geen ticketkanaal.', flags: 64 });
    }
    if (!channel.permissionsFor(interaction.user)?.has(PermissionFlagsBits.ViewChannel)) {
        return interaction.reply({ content: 'Je hebt geen toegang tot dit ticket.', flags: 64 });
    }
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`ticket-close-confirm|${channel.id}|${interaction.user.id}|yes`)
            .setLabel('Ja, sluiten')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`ticket-close-confirm|${channel.id}|${interaction.user.id}|no`)
            .setLabel('Nee, annuleren')
            .setStyle(ButtonStyle.Secondary)
    );
    const embed = new EmbedBuilder()
        .setTitle('Ticket sluiten?')
        .setDescription('Weet je zeker dat je dit ticket wilt sluiten?')
        .setColor(parseInt(config.general.color, 16));

    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
}

async function handleCloseConfirmation(interaction) {
    const [, channelId, expectedUser, decision] = interaction.customId.split('|');
    if (interaction.user.id !== expectedUser) {
        return interaction.reply({ content: 'Alleen de aanvrager kan deze bevestiging gebruiken.', flags: 64 });
    }
    if (decision === 'no') {
        return interaction.update({ content: 'Actie geannuleerd.', embeds: [], components: [] });
    }
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel) {
        return interaction.update({ content: 'Kanaal niet gevonden (mogelijk al gesloten).', embeds: [], components: [] });
    }
    await interaction.update({ content: 'Ticket wordt gesloten…', embeds: [], components: [] });
    await closeTicket(channel, interaction.user);
}

async function closeTicket(channel, closedBy) {
    const meta = parseTicketMeta(channel) || {};
    let transcriptAttachment = null;
    try {
        transcriptAttachment = await createTranscript(channel, {
            limit: -1,
            returnType: 'attachment',
            fileName: `${channel.name}.html`
        });
    } catch (err) {
        console.warn('[Tickets] Transcript mislukt:', err?.message || err);
    }
    const logChannel = config.tickets.logChannelId
        ? channel.guild.channels.cache.get(config.tickets.logChannelId)
        : null;
    if (logChannel?.isTextBased()) {
        const embed = new EmbedBuilder()
            .setTitle('🎫 Ticket gesloten')
            .setColor(0x2ecc71)
            .setTimestamp()
            .setDescription([
                `**Kanaal:** ${channel.name}`,
                `**Categorie:** ${meta.category || 'Onbekend'}`,
                `**Geopend door:** <@${meta.ownerId || 'Onbekend'}>`,
                `**Gesloten door:** <@${closedBy.id}>`
            ].join('\n'));
        await logChannel.send({
            embeds: [embed],
            files: transcriptAttachment ? [transcriptAttachment] : []
        });
    } else if (config.tickets.logChannelId) {
        console.warn('[Tickets] ticketLogChannelId niet gevonden of niet tekstueel.');
    }
    await channel.delete(`Ticket gesloten door ${closedBy.tag}`);
}

async function addParticipant(channel, user) {
    await channel.permissionOverwrites.edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
        AddReactions: true
    });
}

async function removeParticipant(channel, user) {
    const overwrite = channel.permissionOverwrites.cache.get(user.id);
    if (overwrite) {
        await overwrite.delete();
    }
}

async function restrictToAdmins(channel) {
    if (!config.roles.moderatorId) return false;
    await channel.permissionOverwrites.edit(config.roles.moderatorId, {
        ViewChannel: false,
        SendMessages: false
    });
    return true;
}

// Register interaction handlers for ticket panel/buttons
function registerTicketPanel(client) {
    client.once(Events.ClientReady, async () => {
        try {
            const channelId = config.tickets.createChannelId;
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) {
                console.warn('[Tickets] panelkanaal niet gevonden of niet tekstueel.');
                return;
            }
            const existing = (await channel.messages.fetch({ limit: 50 })).find(
                msg => msg.author.id === client.user.id &&
                    msg.components?.some(row =>
                        row.components?.some(comp => comp.customId?.startsWith('ticket-open:'))
                    )
            );
            if (existing) return;
            const embed = new EmbedBuilder()
                .setTitle('🎟️ Ticket Support')
                .setDescription('Kies de categorie die het best past bij je vraag.')
                .setColor(0x6e19e6);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ticket-open:support').setLabel('Support').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('ticket-open:aankopen').setLabel('Aankopen').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('ticket-open:unban').setLabel('Unban').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('ticket-open:bugreport').setLabel('Bug Report').setStyle(ButtonStyle.Primary)
            );
            await channel.send({ embeds: [embed], components: [row] });
        } catch (err) {
            console.error('[Tickets] Fout bij plaatsen ticketpanel:', err);
        }
    });

    // Interaction handler is nu verplaatst naar ticketEmbed.js
}

// Export the slash command similarly to other moderation commands (e.g. unban.js)
async function ticketExecute(interaction) {
    if (!config.features.tickets) {
        const embed = new EmbedBuilder()
            .setDescription('Het ticket systeem is momenteel uitgeschakeld.')
            .setColor(0xED4245);
        return interaction.reply({ embeds: [embed], flags: 64 });
    }
    const channel = interaction.channel;
    if (!isTicketChannel(channel)) {
        const embed = new EmbedBuilder()
            .setDescription('Dit commando kan enkel in ticketkanalen.')
            .setColor(0xED4245);
        return interaction.reply({ embeds: [embed], flags: 64 });
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
        if (!isModOrAdmin(interaction.member)) {
            const embed = new EmbedBuilder()
                .setDescription('Alleen moderators of admins kunnen dit.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }
        // Support zowel 'gebruiker' (nieuw) als 'member' (oude cached command)
        const target = interaction.options.getUser('gebruiker') || interaction.options.getUser('member');
        if (!target) {
            return interaction.reply({ content: 'Gebruiker niet gevonden.', flags: 64 });
        }
        await addParticipant(channel, target);
        const embed = new EmbedBuilder()
            .setDescription(`${target} is toegevoegd aan dit ticket.`)
            .setColor(0x2ecc71);
        return interaction.reply({ embeds: [embed] });
    }
    if (sub === 'remove') {
        if (!isModOrAdmin(interaction.member)) {
            const embed = new EmbedBuilder()
                .setDescription('Alleen moderators of admins kunnen dit.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [embed], flags: 64 });
        }
        // Support zowel 'gebruiker' (nieuw) als 'member' (oude cached command)
        const target = interaction.options.getUser('gebruiker') || interaction.options.getUser('member');
        if (!target) {
            const embed = new EmbedBuilder()
                .setDescription('Gebruiker niet gevonden.')
                .setColor(0xED4245);
            return interaction.reply({ embeds: [embed] });
        }
        await removeParticipant(channel, target);
        const embed = new EmbedBuilder()
            .setDescription(`${target} is verwijderd uit dit ticket.`)
            .setColor(0x2ecc71);
        return interaction.reply({ embeds: [embed] });
    }
    if (sub === 'admin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const embed = new EmbedBuilder()
            .setDescription('Alleen admins kunnen dit.')
            .setColor(0xED4245);
        return interaction.reply({ embeds: [embed], flags: 64 });
        }
        const success = await restrictToAdmins(channel);
        const embed = new EmbedBuilder()
        .setDescription(
            success
            ? 'Moderatorrol heeft geen toegang meer.'
            : 'Er is geen moderatorrol ingesteld in config.'
        )
        .setColor(success ? 0x2ecc71 : 0xED4245);
        return interaction.reply({ embeds: [embed] });
    }
    if (sub === 'close') {
        return promptClose(interaction);
    }
    const embed = new EmbedBuilder()
        .setDescription('Onbekend subcommando.')
        .setColor(0xED4245);
    return interaction.reply({ embeds: [embed], flags: 64 });
}

const slashTicket = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Beheer het huidige ticket')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Voeg een gebruiker toe aan dit ticket')
                .addUserOption(opt =>
                    opt.setName('gebruiker')
                        .setDescription('Gebruiker om toe te voegen')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Verwijder een gebruiker uit dit ticket')
                .addUserOption(opt =>
                    opt.setName('gebruiker')
                        .setDescription('Gebruiker om te verwijderen')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('admin')
                .setDescription('Maak dit ticket enkel zichtbaar voor admins')
        )
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Sluit dit ticket na bevestiging')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        return ticketExecute(interaction);
    }
};

module.exports = {
    commands: [slashTicket],
    registerTicketPanel, // Export for use in index.js
    createTicketChannel,
    parseTicketMeta,
    promptClose,
    handleCloseConfirmation
};