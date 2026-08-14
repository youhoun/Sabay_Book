const crypto = require('crypto');

module.exports = function seed() {
  const now = new Date().toISOString();
  const id = () => crypto.randomUUID();

  const adminId = id();
  const readerId = id();

  const users = [
    { id: adminId, name: 'Admin Demo', email: 'admin@example.com', provider: 'google', role: 'admin', createdAt: now },
    { id: readerId, name: 'Sokha Reader', email: 'sokha@example.com', provider: 'facebook', role: 'user', createdAt: now },
  ];

  const books = [
    {
      id: id(), title: 'Khmer Folktales for Beginners', author: 'Chan Dara', category: 'Culture',
      description: 'A short collection of classic Khmer folktales, retold for new readers.',
      isFree: true, price: 0,
      content: 'Lesson 1: The Rabbit and the Crocodile\n\nLong ago, near the banks of the Mekong, a clever rabbit needed to cross the river...\n\n(Full free lesson content goes here.)',
      createdAt: now,
    },
    {
      id: id(), title: 'English for Everyday Life — Book 1', author: 'Lina Sok', category: 'Language',
      description: 'Practical English phrases for shopping, travel, and daily conversation.',
      isFree: true, price: 0,
      content: 'Lesson 1: Greetings\n\nHello! / Good morning! / How are you?\n\n(Full free lesson content goes here.)',
      createdAt: now,
    },
    {
      id: id(), title: 'Startup Basics: From Idea to Launch', author: 'Vireak Chea', category: 'Business',
      description: 'A practical primer on validating an idea, finding first customers, and shipping v1.',
      isFree: false, price: 0.5,
      content: 'Chapter 1: Talk to 10 people before you write a line of code...\n\n(Full paid content unlocked after purchase.)',
      createdAt: now,
    },
    {
      id: id(), title: 'Cooking with Khmer Herbs', author: 'Sreymom Pich', category: 'Cooking',
      description: 'A short recipe book focused on the herbs and pastes behind everyday Khmer cooking.',
      isFree: false, price: 0.5,
      content: 'Recipe 1: Kroeung paste basics...\n\n(Full paid content unlocked after purchase.)',
      createdAt: now,
    },
    {
      id: id(), title: 'Personal Finance for Young Professionals', author: 'Sopheak Ly', category: 'Finance',
      description: 'Budgeting, saving, and the first steps toward investing — written for a first paycheck.',
      isFree: false, price: 0.5,
      content: 'Chapter 1: Pay yourself first...\n\n(Full paid content unlocked after purchase.)',
      createdAt: now,
    },
    {
      id: id(), title: 'Introduction to Khmer Proverbs', author: 'Chan Dara', category: 'Culture',
      description: 'Twenty everyday proverbs explained with stories and modern context.',
      isFree: true, price: 0,
      content: 'Proverb 1: "Small river, big fish" — meaning and a short story...\n\n(Full free lesson content goes here.)',
      createdAt: now,
    },
  ];

  return { users, books, orders: [], purchases: [], progress: [] };
};
