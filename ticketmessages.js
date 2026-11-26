/**
 * Configuratie voor ticketberichten per categorie.
 * Pas de berichten hieronder aan om de intro-tekst in elk tickettype te wijzigen.
 */

module.exports = {
    support: {
        title: '🛟 Support Ticket',
        description: 'Welkom bij ons support team!\n\nBeschrijf je probleem of vraag zo duidelijk mogelijk. Voeg indien nodig screenshots of andere informatie toe. Ons team zal zo snel mogelijk reageren.',
        color: 0x5865f2,
        emoji: '🛟'
    },
    aankopen: {
        title: '🛒 Aankopen',
        description: 'Welkom bij Aankopen support!\n\nHeb je vragen over een aankoop of wil je iets bestellen? Beschrijf je vraag zo duidelijk mogelijk en ons team helpt je zo snel mogelijk.',
        color: 0x57f287,
        emoji: '🛒'
    },
    unban: {
        title: '🔓 Unban Aanvraag',
        description: 'Welkom bij de unban aanvraag!\n\nOm je unban aanvraag in behandeling te nemen, vragen we je het volgende te vermelden:\n• Je Discord gebruikersnaam en ID\n• Reden van je ban (indien bekend)\n• Waarom denk je dat je unban verdient?\n\nOns team zal je aanvraag zo snel mogelijk bekijken.',
        color: 0xfee75c,
        emoji: '🔓'
    },
    bugreport: {
        title: '🐛 Bug Report',
        description: 'Bedankt dat je een bug wilt melden!\n\nOm de bug zo goed mogelijk te kunnen oplossen, vragen we je het volgende te vermelden:\n• Wat ging er mis?\n• Wat verwachtte je dat er zou gebeuren?\n• Stappen om de bug te reproduceren\n• Screenshots of video\'s (indien mogelijk)\n\nOns team zal de bug zo snel mogelijk onderzoeken.',
        color: 0xed4245,
        emoji: '🐛'
    }
};
