import { useEffect, useState, type FormEvent } from "react";
import { fetchCsrf, signup, usernameAvailable } from "./api";

export function App() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("Pro");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetchCsrf().catch(() => setMessage("Couldn't reach the server"));
  }, []);

  async function onCheck() {
    try {
      const { available } = await usernameAvailable(username);
      setMessage(available ? `${username} is free` : `${username} is taken`);
    } catch {
      setMessage("Couldn't check that name");
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      const account = await signup({ username, email, plan });
      setMessage(`Welcome! You have ${account.credits} credits.`);
    } catch (err) {
      setMessage(`Signup failed: ${(err as Error).message}`);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 420, margin: "2rem auto" }}>
      <h1>Create your account</h1>
      <form onSubmit={onSubmit}>
        <p>
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />{" "}
          <button type="button" onClick={onCheck}>
            Check username
          </button>
        </p>
        <p>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </p>
        <p>
          <select aria-label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option>Free</option>
            <option>Pro</option>
          </select>
        </p>
        <button type="submit">Create account</button>
      </form>
      {message && <p role="status">{message}</p>}
    </main>
  );
}
