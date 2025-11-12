<<<<<<< HEAD
# Blood Donor Directory

A web application for managing blood donor information, built with Node.js, Express, and MySQL.

## Features

- Add and manage blood donor information
- Filter donors by blood group and availability
- Export donor data to Excel/CSV
- Responsive dashboard with statistics

## Prerequisites

- Node.js (v14 or higher)
- MySQL (v5.7 or higher) or MariaDB
- npm or yarn

## Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/blood-donor-directory.git
   cd blood-donor-directory
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up the database**
   - Create a MySQL database
   - Copy `.env.example` to `.env` and update the database credentials
   - Run the database setup script:
     ```bash
     mysql -u your_username -p your_database_name < setup_blood_app.sql
     ```

4. **Start the development server**
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:3000`

## Deployment

### Option 1: Render (Recommended)

1. Push your code to a GitHub repository
2. Sign up at [Render](https://render.com/)
3. Click "New" → "Web Service"
4. Connect your GitHub repository
5. Configure the service:
   - Name: `blood-donor-directory`
   - Region: Choose the one closest to your users
   - Branch: `main`
   - Build Command: `npm install`
   - Start Command: `npm start`
6. Add environment variables:
   - `NODE_ENV`: `production`
   - `PORT`: `10000`
   - Database variables (from your database provider)
7. Click "Create Web Service"

### Option 2: Railway

1. Install the [Railway CLI](https://docs.railway.app/develop/cli)
2. Run:
   ```bash
   railway login
   railway init
   railway up
   ```
3. Set up the database and environment variables in the Railway dashboard

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=your_username
MYSQL_PASSWORD=your_password
MYSQL_DB=blood_app
PORT=3000
NODE_ENV=development
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
=======
# Blood_app
>>>>>>> 0fb4f14a23e021e90e5685de7a754f464fa8a425
