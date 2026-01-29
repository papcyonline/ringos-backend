import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const mockUsers = [
  {
    displayName: 'Amara Okafor',
    bio: 'Going through a tough time, love deep conversations',
    profession: 'Nurse',
    gender: 'female',
    location: 'Lagos, Nigeria',
    status: 'available',
    availabilityNote: 'Available for a long call tonight',
    isOnline: true,
    availableFor: ['text', 'call'],
  },
  {
    displayName: 'James Mwangi',
    bio: 'Here to listen and help. Music keeps me going.',
    profession: 'Software Developer',
    gender: 'male',
    location: 'Nairobi, Kenya',
    status: 'available',
    availabilityNote: 'Free all evening, happy to chat',
    isOnline: true,
    availableFor: ['text', 'call', 'video'],
  },
  {
    displayName: 'Priya Sharma',
    bio: 'Anxiety warrior. Let\'s talk it out together.',
    profession: 'Teacher',
    gender: 'female',
    location: 'Mumbai, India',
    status: 'available',
    availabilityNote: 'Available for 15min text chats',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 5 * 60 * 1000),
    availableFor: ['text'],
  },
  {
    displayName: 'Carlos Rivera',
    bio: 'Night owl, always up for a chat when you can\'t sleep',
    profession: 'Graphic Designer',
    gender: 'male',
    location: 'Mexico City, Mexico',
    status: 'available',
    availabilityNote: 'Will be free for a call in 30 mins',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 45 * 60 * 1000),
    availableFor: ['text', 'video'],
  },
  {
    displayName: 'Fatima Al-Rashid',
    bio: 'Mental health advocate. You are not alone.',
    profession: 'Psychologist',
    gender: 'female',
    location: 'Dubai, UAE',
    status: 'available',
    availabilityNote: 'Open for deep talks anytime',
    isOnline: true,
    availableFor: ['text', 'call', 'video'],
  },
  {
    displayName: 'Liam Chen',
    bio: 'Recovering from burnout. Let\'s support each other.',
    profession: 'Product Manager',
    gender: 'male',
    location: 'Toronto, Canada',
    status: 'busy',
    availabilityNote: 'In a meeting, free after 4pm',
    isOnline: true,
    availableFor: ['text'],
  },
  {
    displayName: 'Sofia Andersson',
    bio: 'Sometimes you just need someone who gets it',
    profession: 'Student',
    gender: 'female',
    location: 'Stockholm, Sweden',
    status: 'available',
    availabilityNote: 'Available for a quick 10min chat',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    availableFor: ['text', 'call'],
  },
  {
    displayName: 'David Osei',
    bio: 'Calm listener. No judgement here.',
    profession: 'Social Worker',
    gender: 'male',
    location: 'Accra, Ghana',
    status: 'available',
    availabilityNote: 'Happy to listen for as long as you need',
    isOnline: true,
    availableFor: ['text', 'call', 'video'],
  },
  {
    displayName: 'Yuki Tanaka',
    bio: 'Finding peace one day at a time',
    profession: 'Artist',
    gender: 'female',
    location: 'Tokyo, Japan',
    status: 'available',
    availabilityNote: 'Prefer texting, available now',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 20 * 60 * 1000),
    availableFor: ['text'],
  },
  {
    displayName: 'Alex Morgan',
    bio: 'Here for deep talks and real connections',
    profession: 'Life Coach',
    gender: 'other',
    location: 'London, UK',
    status: 'available',
    availabilityNote: 'Available for 30min video calls',
    isOnline: true,
    availableFor: ['text', 'video'],
  },
  {
    displayName: 'Thandiwe Ndlovu',
    bio: 'Healing isn\'t linear. Let\'s walk together.',
    profession: 'Counsellor',
    gender: 'female',
    location: 'Johannesburg, SA',
    status: 'available',
    availabilityNote: 'Can do a quick call right now',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
    availableFor: ['text', 'call'],
  },
  {
    displayName: 'Marco Silva',
    bio: 'Overthinking? Me too. Let\'s distract each other.',
    profession: 'Chef',
    gender: 'male',
    location: 'São Paulo, Brazil',
    status: 'busy',
    availabilityNote: 'Back online tomorrow morning',
    isOnline: false,
    lastSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    availableFor: ['text'],
  },
];

async function main() {
  // Clear existing mock users (keep real registered users with email/password)
  await prisma.user.deleteMany({
    where: { email: null, phoneHash: null, deviceId: null },
  });

  console.log('Seeding mock users...');

  for (const user of mockUsers) {
    await prisma.user.create({
      data: {
        displayName: user.displayName,
        bio: user.bio,
        profession: user.profession,
        gender: user.gender,
        location: user.location,
        status: user.status,
        availabilityNote: user.availabilityNote,
        isAnonymous: false,
        isOnline: user.isOnline,
        lastSeenAt: user.lastSeenAt ?? null,
        availableFor: user.availableFor,
      },
    });
    console.log(`  + ${user.displayName} — ${user.profession}`);
  }

  console.log(`\nDone! Created ${mockUsers.length} mock users.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
