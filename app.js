const express = require("express");
const path = require("path");
const axios = require("axios");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const cookieParser = require("cookie-parser");
const Pokemon = require("./models/pokemon");
const User = require("./models/user");
const expressLayouts = require("express-ejs-layouts");
require("dotenv").config();

// Initialize Express app
const app = express();

// Set the view engine to EJS
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());
app.use(expressLayouts);
app.set("layout", "layout");
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "pokemon-secret-key",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

// Make user available to all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

// Authentication routes
app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("login", {
    title: "Login",
    error: req.session.error,
  });
  // Clear any error messages
  delete req.session.error;
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Find user by username
    const user = await User.findOne({ username });

    if (!user || !user.validatePassword(password)) {
      req.session.error = "Invalid username or password";
      return res.redirect("/login");
    }

    // Set user in session
    req.session.user = {
      id: user._id,
      username: user.username,
    };

    // Log login activity
    await user.logActivity("login");

    res.redirect("/");
  } catch (error) {
    console.error("Login error:", error);
    req.session.error = "An error occurred during login";
    res.redirect("/login");
  }
});

app.get("/signup", (req, res) => {
  if (req.session.user) {
    return res.redirect("/");
  }
  res.render("signup", {
    title: "Sign Up",
    error: req.session.error,
  });
  // Clear any error messages
  delete req.session.error;
});

app.post("/signup", async (req, res) => {
  try {
    const { username, email, password, confirmPassword } = req.body;

    // Check if passwords match
    if (password !== confirmPassword) {
      req.session.error = "Passwords do not match";
      return res.redirect("/signup");
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      req.session.error = "Username or email already in use";
      return res.redirect("/signup");
    }

    // Create new user
    const user = new User({ username, email });
    user.setPassword(password);
    await user.save();

    // Log signup activity
    await user.logActivity("signup");

    // Log user in
    req.session.user = {
      id: user._id,
      username: user.username,
    };

    res.redirect("/");
  } catch (error) {
    console.error("Signup error:", error);
    req.session.error = "An error occurred during signup";
    res.redirect("/signup");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    return next();
  }
  res.redirect("/login");
};

// API route to get a Pokemon sprite for timeline
app.get("/api/pokemon/:id/sprite", async (req, res) => {
  try {
    const response = await axios.get(
      `https://pokeapi.co/api/v2/pokemon/${req.params.id}`,
      { credentials: "omit" }
    );
    res.redirect(response.data.sprites.front_default);
  } catch (error) {
    res.status(404).send("Pokemon not found");
  }
});

// Routes
// Dashboard - Show Pokemon from PokeAPI
app.get("/",  async (req, res) => {
  try {
    // Fetch data from PokeAPI
    const response = await axios.get(
      "https://pokeapi.co/api/v2/pokemon?limit=40",{ credentials: 'omit' }
    );
    const pokemonList = response.data.results;

    // Get detailed information for each Pokemon
    const detailedPokemon = await Promise.all(
      pokemonList.map(async (pokemon) => {
        const details = await axios.get(pokemon.url);
        return {
          id: details.data.id,
          name: details.data.name,
          sprite: details.data.sprites.front_default,
          types: details.data.types.map((type) => type.type.name),
        };
      })
    );

    let favoritePokemonIds = [];

    // If user is logged in, check for favorites
    if (req.session.user) {
      const userPokemon = await Pokemon.find({ userId: req.session.user.id });
      favoritePokemonIds = userPokemon
        .filter((p) => p.isFavorite)
        .map((p) => p.pokemonId);

      // Log activity for viewing dashboard
      const user = await User.findById(req.session.user.id);
      await user.logActivity("view_pokemon", {
        pokemonName: "dashboard",
        details: { page: "dashboard" },
      });
    }

    // Add isFavorite flag to each Pokemon
    const pokemonWithFavorites = detailedPokemon.map((pokemon) => ({
      ...pokemon,
      isFavorite: favoritePokemonIds.includes(pokemon.id),
    }));

    res.render("dashboard", {
      title: "Pokemon Dashboard",
      pokemon: pokemonWithFavorites,
    });
  } catch (error) {
    console.error("Error fetching Pokemon:", error);
    res.status(500).render("dashboard", {
      title: "Pokemon Dashboard",
      error: "Failed to fetch Pokemon",
      pokemon: [],
    });
  }
});

// to get specific pokemon GET https://pokeapi.co/api/v2/pokemon/{id or name}/
// Getting the pokemons per Generations
/**
 * for full stats use https://pokeapi.co/api/v2/pokemon/{id}
 * generation link has the species information, not specific info of pokemon
 */
app.get("/generation/:id", async (req, res) => {
  try {
    const generationId = req.params.id;
    const response = await axios.get(
      `https://pokeapi.co/api/v2/generation/${generationId}`
    );

    const generation = {
      id: response.data.id,
      name: response.data.name,
      region: response.data.main_region.name,
      pokemon: response.data.pokemon_species.map((poke_spec) => ({
        name: poke_spec.stat.name,
        url: "https://pokeapi.co/api/v2/pokemon/" + poke_spec.stat.name,
      })),
    };

    let isFavorite = false;

    // If user is logged in, check if this is a favorite and log the view
    if (req.session.user) {
      const savedPokemon = await Pokemon.findOne({
        userId: req.session.user.id,
        name: parseInt(pokemonId),
      });

      isFavorite = savedPokemon ? savedPokemon.isFavorite : false;

      // Log the view
      const user = await User.findById(req.session.user.id);
      await user.logActivity("view_pokemon", {
        pokemonId: parseInt(pokemonId),
        pokemonName: pokemon.name,
      });
    }

    res.render("pokemon-detail", {
      title: `Pokémon: ${pokemon.name}`,
      pokemon,
      isFavorite,
    });
  } catch (error) {
    console.error("Error fetching Pokemon details:", error);
    res.status(500).render("error", {
      title: "Error",
      message: "Failed to fetch Pokemon details",
      error,
    });
  }
});

// Favorites page - Requires authentication
app.get("/favorites",  async (req, res) => {
  try {
    const favorites = await Pokemon.find({
      userId: req.session.user.id,
      isFavorite: true,
    }).sort({ dateAdded: -1 });

    // Log activity
    const user = await User.findById(req.session.user.id);
    await user.logActivity("view_pokemon", {
      pokemonName: "favorites",
      details: { page: "favorites" },
    });

    res.render("favorites", {
      title: "Favorite Pokemon",
      favorites,
    });
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).render("favorites", {
      title: "Favorite Pokemon",
      error: "Failed to fetch favorites",
      favorites: [],
    });
  }
});

// Timeline page - Requires authentication
app.get("/timeline", async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id);
    const activities = user.activities.sort(
      (a, b) => b.timestamp - a.timestamp
    );

    res.render("timeline", {
      title: "Activity Timeline",
      activities,
    });
  } catch (error) {
    console.error("Error fetching timeline:", error);
    res.status(500).render("timeline", {
      title: "Activity Timeline",
      error: "Failed to fetch timeline",
      activities: [],
    });
  }
});

// Add a Pokemon to favorites - Requires authentication
app.post("/api/favorites",  async (req, res) => {
  try {
    const { pokemonId, name, sprite, types } = req.body;

    // Try to find if it already exists
    let pokemon = await Pokemon.findOne({
      userId: req.session.user.id,
      pokemonId: parseInt(pokemonId),
    });

    if (pokemon) {
      // Update the existing record
      pokemon.isFavorite = true;
      await pokemon.save();
    } else {
      // Create a new record
      pokemon = await Pokemon.create({
        userId: req.session.user.id,
        pokemonId: parseInt(pokemonId),
        name,
        sprite,
        types,
        isFavorite: true,
      });
    }

    // Log activity
    const user = await User.findById(req.session.user.id);
    await user.logActivity("add_favorite", {
      pokemonId: parseInt(pokemonId),
      pokemonName: name,
    });

    res.json({ success: true, pokemon });
  } catch (error) {
    console.error("Error adding favorite:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Remove a Pokemon from favorites - Requires authentication
app.delete("/api/favorites/:id", async (req, res) => {
  try {
    const pokemon = await Pokemon.findOne({
      userId: req.session.user.id,
      pokemonId: parseInt(req.params.id),
    });

    if (!pokemon) {
      return res.status(404).json({
        success: false,
        error: "Pokemon not found",
      });
    }

    // Get pokemon details before updating
    const pokemonName = pokemon.name;

    // Set isFavorite to false instead of deleting
    pokemon.isFavorite = false;
    await pokemon.save();

    // Log activity
    const user = await User.findById(req.session.user.id);
    await user.logActivity("remove_favorite", {
      pokemonId: parseInt(req.params.id),
      pokemonName: pokemonName,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error removing favorite:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// View specific pokemon details - Logs the activity if user is logged in
app.get("/pokemon/:id", async (req, res) => {
  try {
    const numId = parseInt(req.params.id, 10);
    let api_url = "";
    //made this feature robust by allowing to use both name and ID
    if (!isNaN(numId)) {
      // Using ID
      const pokemonId = req.params.id;
      api_url = `https://pokeapi.co/api/v2/pokemon/${pokemonId}`;
    } else {
      // Using name
      const pokemonName = req.params.id;
      api_url = `https://pokeapi.co/api/v2/pokemon/${pokemonName}`;
    }

    const response = await axios.get(api_url);

    const pokemon = {
      id: response.data.id,
      name: response.data.name,
      sprite: response.data.sprites.front_default,
      types: response.data.types.map((type) => type.type.name),
      height: response.data.height / 10, // Convert to meters
      weight: response.data.weight / 10, // Convert to kg
      abilities: response.data.abilities.map((ability) => ability.ability.name),
      stats: response.data.stats.map((stat) => ({
        name: stat.stat.name,
        value: stat.base_stat,
      })),
    };

    let isFavorite = false;

    // If user is logged in, check if this is a favorite and log the view
    if (req.session.user) {
      const savedPokemon = await Pokemon.findOne({
        userId: req.session.user.id,
        pokemonId: parseInt(pokemon.id),
      });

      isFavorite = savedPokemon ? savedPokemon.isFavorite : false;

      // Log the view
      const user = await User.findById(req.session.user.id);
      await user.logActivity("view_pokemon", {
        pokemonId: parseInt(pokemon.id),
        pokemonName: pokemon.name,
      });
    }

    res.render("pokemon-detail", {
      title: `Pokémon: ${pokemon.name}`,
      pokemon,
      isFavorite,
    });
  } catch (error) {
    console.error("Error fetching Pokemon details:", error);
    res.status(500).render("error", {
      title: "Error",
      message: "Failed to fetch Pokemon details",
      error,
    });
  }
});

module.exports = app;
