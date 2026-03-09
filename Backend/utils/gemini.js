import "dotenv/config";

const getGeminiAPIResponse = async (message) => {
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: message }],
        },
      ],
    }),
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      options
    );

    if (!response.ok) {
      throw new Error(`Gemini API failed: ${response.status}`);
    }

    const data = await response.json();

    // ✅ Defensive checks
    if (
      !data?.candidates?.length ||
      !data.candidates[0]?.content?.parts?.length
    ) {
      throw new Error("Invalid or empty Gemini response");
    }

    return data.candidates[0].content.parts[0].text;

  } catch (err) {
    console.error("Gemini API Error:", err.message);
    throw err; // 👈 VERY IMPORTANT
  }
};

export default getGeminiAPIResponse;