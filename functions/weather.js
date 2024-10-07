const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    const apiKey = process.env.API_KEY; // Accessing the environment variable
    const city = 'Oak Creek,WI';
    const url = `http://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=imperial`;

    const response = await fetch(url);
    const data = await response.json();

    return {
        statusCode: 200,
        body: JSON.stringify(data),
    };
};
