const {
    Events,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const {
    createTicketChannel,
    parseTicketMeta,
    promptClose,
    handleCloseConfirmation
} = require('../../commands/[TICKETS]/ticket.js');
const config = require('../../config.js');
const ticketMessages = require('../../ticketmessages.js');

const TICKET_CATEGORIES = {
    support: { label: 'Support', emoji: '🛟', description: 'Algemene ondersteuning' },
    aankopen: { label: 'Aankopen', emoji: '🛒', description: 'Vragen over aankopen' },
    unban: { label: 'Unban', emoji: '🔓', description: 'Unban aanvraag' },
    bugreport: { label: 'Bug Report', emoji: '🐛', description: 'Meld een bug' }
};

module.exports = function registerTicketPanel(client) {
    client.once(Events.ClientReady, async () => {
        if (!config.features.tickets) {
            console.log('[Tickets] Ticket systeem is uitgeschakeld in config.');
            return;
        }
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
                .setDescription('Kies de categorie die het best past bij je vraag. In dit ticket kun je je vraag stellen en ons team zal je zo snel mogelijk helpen!')
                .setColor(0x6e19e6);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ticket-open:support').setLabel('Support').setEmoji(ticketMessages.support.emoji).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('ticket-open:aankopen').setLabel('Aankopen').setEmoji(ticketMessages.aankopen.emoji).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('ticket-open:unban').setLabel('Unban').setEmoji(ticketMessages.unban.emoji).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('ticket-open:bugreport').setLabel('Bug Report').setEmoji(ticketMessages.bugreport.emoji).setStyle(ButtonStyle.Secondary)
            );
            await channel.send({ embeds: [embed], components: [row] });
        } catch (err) {
            console.error('[Tickets] Fout bij plaatsen ticketpanel:', err);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!config.features.tickets) return;
        if (!interaction.inGuild() || !interaction.isButton()) return;
        const { customId } = interaction;
        if (customId.startsWith('ticket-open:')) {
            const categoryKey = customId.split(':')[1];
            const meta = TICKET_CATEGORIES[categoryKey];
            if (!meta) {
                return interaction.reply({ content: 'Onbekende ticketcategorie.', flags: 64 });
            }
            await interaction.deferReply({ flags: 64 });
            const existing = interaction.guild.channels.cache.find(ch =>
                ch.parentId === config.tickets.categoryId &&
                ch.isTextBased() &&
                parseTicketMeta(ch)?.ownerId === interaction.user.id
            );
            if (existing) {
                return interaction.editReply({ content: `Je hebt al een ticket open: ${existing}` });
            }
            try {
                const channel = await createTicketChannel(interaction, categoryKey, meta);
                const ticketEmbed = new EmbedBuilder()
                    .setTitle('🎟️ Ticket Aangemaakt')
                    .setDescription(`Je ticket is aangemaakt: ${channel}`)
                    .setColor(0x6e19e6);
                await interaction.editReply({ embeds: [ticketEmbed] });
            } catch (err) {
                console.error('[Tickets] Fout bij aanmaken ticket:', err);
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Ticket Fout')
                    .setDescription('Kan ticket niet aanmaken. Controleer permissies.')
                    .setColor(0xff0000);
                await interaction.editReply({ embeds: [errorEmbed] });
            }
        }
        if (customId === 'ticket-close') {
            return promptClose(interaction);
        }
        if (customId.startsWith('ticket-close-confirm|')) {
            return handleCloseConfirmation(interaction);
        }
    });
};