const express = require('express');
const router = express.Router();
const pool = require('../db/db.js');
const MD5 = require('md5');
const volunteers = require('../db/volunteers');
const events = require('../db/events');
const profiles = require('../db/profileData'); // Import the profiles file
const fs = require('fs');
const path = require('path');
const matchVolunteerToEvents = require('../services/volunteerMatching');
const notifyVolunteersAssignedToEvent = require('../services/volunteerMatching');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();
const PDFDocument = require('pdfkit');
const { createObjectCsvWriter } = require('csv-writer');
const { Parser } = require('json2csv');


// Configure nodemailer
var transporter = nodemailer.createTransport({
    service: 'Gmail', // Or your email service
    auth: {
        user: process.env.GMAIL_USER, // Replace with your email
        pass: process.env.GMAIL_PASSWORD // Replace with your email password
    }
});

// API to send the verification email
router.post('/sendVerificationEmail', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    try {
        // Generate a verification token
        const token = crypto.randomBytes(32).toString('hex').substring(0, 100);

        // Update the UserCredentials table with the token
        const result = await pool.query('UPDATE UserCredentials SET verificationToken = $1 WHERE userId = $2;', [token, email]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: "Email not found." });
        }

        // Send email
        const verificationLink = `http://localhost:4000/verifyEmail?token=${token}&email=${encodeURIComponent(email)}`;
        const mailOptions = {
            from: 'carterung@gmail.com',
            to: email,
            subject: 'Verify your email address',
            text: `Click the link to verify your email: ${verificationLink}`,
            html: `<p>Click the link to verify your email:</p><a href="${verificationLink}">${verificationLink}</a>`
        };

        await transporter.sendMail(mailOptions, function(error, res) {
            if (error) {
                console.log(error);
            } else {
                console.log("Message Sent");
            }
        });
        res.status(200).json({ message: 'Verification email sent.' });
    } catch (error) {
        console.error('Error sending email:', error.message);
        res.status(500).json({ message: 'Failed to send verification email.' });
    }
});


router.get('/verifyEmail', async (req, res) => {
    const { token, email } = req.query;

    if (!token || !email) {
        return res.status(400).json({ message: 'Invalid verification link.' });
    }

    try {
        // Retrieve the token from the database
        const query = 'SELECT verificationToken FROM UserCredentials WHERE userId = $1;';
        const result = await pool.query(query, [email]);

        if (result.rows.length === 0 || result.rows[0].verificationtoken !== token) {
            return res.status(400).json({ message: 'Invalid or expired token.' });
        }

        // Mark the user as verified and clear the token
        await pool.query(
            'UPDATE UserCredentials SET verified = TRUE, verificationToken = NULL WHERE userId = $1;',
            [email]
        );

        // Redirect to profile form after verification
        res.status(200).redirect('http://localhost:3000/profileForm');
    } catch (error) {
        console.error('Error verifying email:', error.message);
        res.status(500).json({ message: 'Failed to verify email.' });
    }
});


router.get('/volunteers', async (req, res) => {
    try {
        const query = `
            SELECT 
                u.*, 
                ARRAY_AGG(DISTINCT s.skillName) AS skills, 
                ARRAY_AGG(DISTINCT a.availabilityDate) AS availabilityDates,
                c.pass
            FROM 
                UserProfile AS u
            JOIN 
                UserSkills AS us ON u.id = us.userId
            JOIN 
                Skills AS s ON us.skillId = s.id
            JOIN 
                UserAvailability AS a ON u.id = a.userId
            JOIN 
                UserCredentials AS c ON u.credentialsId = c.id
            GROUP BY 
                u.id, c.pass;
        `;
        const volunteers = await pool.query(query);
        return res.json(volunteers.rows);
    } catch (error) {
        console.error(error.message);
    }
})

// router.get('/volunteers_match', async (req, res) => {
//     try {
//         const query = `
//             SELECT 
//                 u.id AS userId, 
//                 u.fullName AS name, 
//                 u.city, 
//                 s.skillName, 
//                 a.availabilityDate
//             FROM 
//                 UserProfile AS u
//             LEFT JOIN UserSkills AS us ON u.id = us.userId
//             LEFT JOIN Skills AS s ON us.skillId = s.id
//             LEFT JOIN UserAvailability AS a ON u.id = a.userId;
//         `;
//         const rows = await pool.query(query);

//         // Transform rows into the desired format
//         const volunteersMap = new Map();

//         rows.rows.forEach(row => {
//             if (!volunteersMap.has(row.userid)) {
//                 // Add new user entry if not already in the map
//                 volunteersMap.set(row.userid, {
//                     id: row.userId,
//                     name: row.name,
//                     city: row.city,
//                     skills: [],
//                     availability: [],
//                 });
//             }

//             // Add skill if it exists and is not already in the array
//             if (row.skillname && !volunteersMap.get(row.userid).skills.includes(row.skillname)) {
//                 volunteersMap.get(row.userid).skills.push(row.skillname);
//             }

//             // Add availability date if it exists and is not already in the array
//             if (row.availabilitydate && !volunteersMap.get(row.userid).availability.includes(row.availabilitydate)) {
//                 volunteersMap.get(row.userid).availability.push(row.availabilitydate);
//             }
//         });

//         // Convert the map to an array of volunteers
//         const volunteers = Array.from(volunteersMap.values());

//         res.json(volunteers);
//     } catch (error) {
//         console.error("Error fetching volunteers:", error.message);
//         res.status(500).json({ message: "Internal server error" });
//     }
// });

// API to generate a report (PDF or CSV)
router.get('/generateReport', async (req, res) => {
    const { format } = req.query; // `format` can be 'pdf' or 'csv'

    if (!format || !['pdf', 'csv'].includes(format.toLowerCase())) {
        return res.status(400).json({ message: "Invalid format. Use 'pdf' or 'csv'." });
    }

    try {
        // Query for Volunteer Report
        const volunteerQuery = `
            SELECT
                up.fullName AS volunteerName,
                COALESCE(STRING_AGG(ed.eventName, ', '), 'None') AS events
            FROM
                UserProfile up
            LEFT JOIN
                UserEvents ue ON up.id = ue.userId
            LEFT JOIN
                EventDetails ed ON ue.eventId = ed.id
            GROUP BY
                up.fullName;
        `;
        const volunteerResult = await pool.query(volunteerQuery);

        // Query for Event Report
        const eventQuery = `
            SELECT
                ed.eventName AS eventName,
                COALESCE(STRING_AGG(up.fullName, ', '), 'None') AS volunteers
            FROM
                EventDetails ed
            LEFT JOIN
                UserEvents ue ON ed.id = ue.eventId
            LEFT JOIN
                UserProfile up ON ue.userId = up.id
            GROUP BY
                ed.eventName;
        `;
        const eventResult = await pool.query(eventQuery);

        // Prepare data for report
        const volunteerData = volunteerResult.rows;
        const eventData = eventResult.rows;

        if (format.toLowerCase() === 'csv') {
            // Generate CSV format
            let csvContent = 'Volunteer Report\n';
            csvContent += 'Volunteer Name, Events Participated\n';
            volunteerData.forEach(row => {
                csvContent += `"${row.volunteername}","${row.events}"\n`;
            });

            csvContent += '\nEvent Report\n';
            csvContent += 'Event Name, Assigned Volunteers\n';
            eventData.forEach(row => {
                csvContent += `"${row.eventname}","${row.volunteers}"\n`;
            });

            res.setHeader('Content-Disposition', 'attachment; filename=report.csv');
            res.setHeader('Content-Type', 'text/csv');
            res.send(csvContent);
        } else if (format.toLowerCase() === 'pdf') {
            // Generate PDF format
            const PDFDocument = require('pdfkit');
            const doc = new PDFDocument();

            res.setHeader('Content-Disposition', 'attachment; filename=report.pdf');
            res.setHeader('Content-Type', 'application/pdf');

            doc.pipe(res);

            // Volunteer Report
            doc.fontSize(16).text('Volunteer Report', { underline: true });
            doc.moveDown();
            doc.fontSize(12);
            volunteerData.forEach(row => {
                doc.text(`Volunteer Name: ${row.volunteername}`);
                doc.text(`Event Participation: ${row.events}`);
                doc.moveDown();
            });

            doc.addPage();

            // Event Report
            doc.fontSize(16).text('Event Report', { underline: true });
            doc.moveDown();
            doc.fontSize(12);
            eventData.forEach(row => {
                doc.text(`Event Name: ${row.eventname}`);
                doc.text(`Volunteers: ${row.volunteers}`);
                doc.moveDown();
            });

            doc.end();
        }
    } catch (error) {
        console.error('Error generating report:', error.message);
        res.status(500).json({ message: 'Failed to generate report.' });
    }
});



router.post('/login', async (req, res) => {
    const { email, pass, role } = req.body;

    if (!email || !pass) {
        return res.status(400).json({ message: "Email and password are required." });
    }

    if (!role) {
        return res.status(400).json({ message: "Selected role is required." });
    }

    try {
        // Query the UserCredentials table to find the user by email
        const query = 'SELECT * FROM UserCredentials WHERE userId = $1;';
        const result = await pool.query(query, [email]);

        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Email or password not found." });
        }

        const user = result.rows[0];
        const hashedPassword = MD5(pass);

        // Check if the hashed password matches the stored password
        if (hashedPassword !== user.pass) {
            console.log(hashedPassword);
            console.log(user.pass);
            return res.status(401).json({ message: "Invalid email or password." });
        }

        // Check if the role matches the user's isAdmin status
        if ((role === 'admin' && !user.isadmin) || (role === 'user' && user.isadmin)) {
            return res.status(401).json({ message: "Invalid role selected for this user." });
        }

        // Successful login
        res.status(200).json({
            message: "Login successful",
            userId: user.id,
            email: user.userid,
            isAdmin: user.isadmin
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ message: "Internal server error." });
    }
});


router.get('/events', async (req, res) => {
    try {
        const query = `
            SELECT 
                e.*,
                ARRAY_AGG(s.skillName) AS skills
            FROM 
                EventDetails AS e
            JOIN 
                EventSkills AS es ON e.id = es.eventId
            JOIN 
                Skills AS s ON es.skillId = s.id
            GROUP BY 
                e.id;
        `;
        const events = await pool.query(query);
        console.log(events);
        return res.json(events.rows);
    } catch (error) {
        console.error(error.message);
    }
})

router.get('/skills', async (req, res) => {
    try {
        const query = `
            SELECT 
                s.*
            FROM 
                Skills AS s;
        `;
        const skills = await pool.query(query);
        res.json(skills.rows);
    } catch (error) {
        console.error(error.message);
    }
})

router.get('/states', async (req, res) => {
    try {
        const query = `
            SELECT 
                s.*
            FROM 
                States AS s;
        `;
        const states = await pool.query(query);
        res.json(states.rows);
    } catch (error) {
        console.error(error.message);
    }
})

router.get('/notifications', async (req, res) => {
    try {
        const { userId } = req.query;  // Get userId from query parameters

        const query = `
            SELECT 
                n.*
            FROM 
                Notifications AS n
            WHERE
                n.userId = $1; 
        `;
        
        const notifications = await pool.query(query, [userId]); 
        return res.json(notifications.rows);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

// POST request for registering a new volunteer
router.post('/volunteerRegister', async (req, res) => {
    const {
        email,
        pass,
        isadmin, 
        id
    } = req.body;

    try {
        // Check that email and password are provided
        if (!email || !pass) {
            return res.status(400).json({ message: "Email and password are required." });
        }

        // Check if the email already exists in the UserCredentials table
        const emailCheckQuery = 'SELECT * FROM UserCredentials WHERE userId = $1;';
        const result = await pool.query(emailCheckQuery, [email]);

        if (result.rows.length > 0) {
            return res.status(409).json({ message: "Email already exists." });
        }
        let credentialResult;
        // Insert into UserCredentials table
        if (id){
            credentialResult = await pool.query(
                'INSERT INTO UserCredentials (id, userId, pass, isAdmin) VALUES ($1, $2, $3, $4) RETURNING id;', 
                [id, email, MD5(pass), isadmin]
            );
        } else {
            credentialResult = await pool.query(
                'INSERT INTO UserCredentials (userId, pass, isAdmin) VALUES ($1, $2, $3) RETURNING id;', 
                [email, MD5(pass), isadmin]
            );
        }
        const credentialsId = credentialResult.rows[0].id;
        const userId = credentialResult.rows[0].userId;

        // Insert into UserProfile table with reference to credentialsId
        const profileResult = await pool.query(`
            INSERT INTO UserProfile (credentialsId, fullName, email, address1, city, stateId, zipCode, isAdmin) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id;`,
            [credentialsId, '', email, '', '', 1, '', isadmin]
        );

        // const userId = profileResult.rows[0].id;

        res.status(201).json({ message: "Registration Successful", userId, credentialsId });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: "An error occurred during registration" });
    }
});

router.delete('/deleteUser', async (req, res) => {
    const { email } = req.body;

    try {
        // Check that email is provided
        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }

        // Retrieve the credentialsId associated with the email
        const getCredentialsIdQuery = `
            SELECT id FROM UserCredentials WHERE userId = $1;
        `;
        const credentialsResult = await pool.query(getCredentialsIdQuery, [email]);

        if (credentialsResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }

        const credentialsId = credentialsResult.rows[0].id;

        // Delete from UserProfile table
        const deleteUserProfileQuery = `
            DELETE FROM UserProfile WHERE credentialsId = $1;
        `;
        await pool.query(deleteUserProfileQuery, [credentialsId]);

        // Delete from UserCredentials table
        const deleteUserCredentialsQuery = `
            DELETE FROM UserCredentials WHERE id = $1;
        `;
        await pool.query(deleteUserCredentialsQuery, [credentialsId]);

        res.status(200).json({ message: "User deleted successfully." });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ message: "An error occurred while deleting the user." });
    }
});


// POST request for saving profile data
router.post('/saveProfile', async (req, res) => {
    const { fullName, address1, address2, city, stateId, zipCode, preferences, skills = [], availability = [], credentialsId } = req.body;

    if (!credentialsId) {
        return res.status(400).json({ message: "Credentials ID is required." });
    }

    try {
        // Fetch the userId using credentialsId
        const fetchUserQuery = `SELECT id FROM UserProfile WHERE credentialsId = $1;`;
        const userResult = await pool.query(fetchUserQuery, [credentialsId]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }

        const userId = userResult.rows[0].id;
        console.log("Fetched userId:", userId); // Debugging log

        // Update the UserProfile table
        await pool.query(
            'UPDATE UserProfile SET fullName = $1, address1 = $2, address2 = $3, city = $4, stateId = $5, zipCode = $6, preferences = $7 WHERE credentialsId = $8;',
            [fullName, address1, address2, city, stateId, zipCode, preferences, credentialsId]
        );

        // Insert or update skills
        for (const skill of skills) {
            const skillResult = await pool.query('SELECT id FROM Skills WHERE skillname = $1;', [skill]);
            if (skillResult.rows.length > 0) {
                const skillId = skillResult.rows[0].id;
                await pool.query(
                    `INSERT INTO UserSkills (userId, skillId) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
                    [userId, skillId]
                );
            } else {
                console.error(`Skill "${skill}" not found in Skills table.`);
            }
        }

        // Insert or update availability
        for (const date of availability) {
            await pool.query(
                `INSERT INTO UserAvailability (userId, availabilityDate) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
                [userId, date]
            );
        }

        res.status(200).json({ message: "Profile data updated successfully." });
    } catch (error) {
        console.error("Error saving profile data:", error.message);
        res.status(500).json({ message: "Error saving profile data." });
    }
});


// POST request for saving event data
router.post('/saveEvent', async (req, res) => {
    const { eventName, eventDescription, location, urgency, eventDate, requiredSkills = [] } = req.body;

    try {
        const result = await pool.query('INSERT INTO eventdetails (eventname, eventdescr, eventlocation, urgency, eventdate) VALUES ($1, $2, $3, $4, $5) RETURNING id;', [eventName, eventDescription, location, urgency, eventDate]);
        const eventId = result.rows[0].id;

        const skillIds = [];
        for (const skillName of requiredSkills) {
        const skillResult = await pool.query(
            'SELECT id FROM skills WHERE skillname = $1;',
            [skillName]
        );

        if (skillResult.rows.length > 0) {
            skillIds.push(skillResult.rows[0].id);
        } else {
            console.error("Skill not found in database.");
        }
        }

        for (const skillId of skillIds) {
            await pool.query('INSERT INTO eventskills (eventId, skillId) VALUES ($1, $2);', [eventId, skillId]);
        }

        return res.status(201).json({ message: "Event data saved successfully", eventId });
    } catch (error) {
        console.error(error.message);
        return res.status(500).json({ message: "Error saving event data" });
    }
}); 

router.get('/notifications/:id', async (req, res) => {
    console.log(req.params);
    const userId = parseInt(req.params.id);  
    
    try {
        const notifications = await pool.query(`
            SELECT 
                n.id, 
                n.notificationtext, 
                n.notificationdate, 
                n.userid 
            FROM 
                Notifications n
            WHERE 
                n.userid = $1 
        `, [userId]);

        return res.json(notifications.rows);  
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/volunteers/:id/history', async (req, res) => {
    const volunteerId = req.params.id;

    try {
        await pool.query(`
            UPDATE volunteerhistory
            SET participation = CASE
                WHEN eventid IN (
                    SELECT id 
                    FROM eventdetails AS e
                    WHERE e.eventDate < CURRENT_DATE
                ) THEN 'Participated'
                ELSE 'Not Participated'
            END
            WHERE userid = $1;
        `, [volunteerId]);
        
        const events = await pool.query(`
            SELECT e.*, vp.participation, array_agg(s.skillname) AS requiredSkills
            FROM eventdetails e
            LEFT JOIN volunteerhistory vp ON e.id = vp.eventid AND vp.userid = $1
            LEFT JOIN eventskills es ON e.id = es.eventid
            LEFT JOIN skills s ON es.skillid = s.id
            GROUP BY e.id, vp.participation
        `, [volunteerId]);
        console.log(events.rows);
        res.json({
            events: events.rows,
        });
    } catch (error) {
        console.error('Error fetching volunteer history:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});



// router.get('/volunteer/:id/match-events', (req, res) => {
//     const volunteerID = parseInt(req.params.id);

//     const volunteer = volunteers.find(v => v.id === volunteerID);

//     if (!volunteer) {
//         return res.status(404).json({ message: `Volunteer with ID ${volunteerID} not found.` });
//     }
//     console.log(volunteer)
//     const matchedEvents = matchVolunteerToEvents(volunteer, events);

//     return res.json({
//         volunteerName: volunteer.name,
//         matchingEvents: matchedEvents
//     });
// });
router.get('/volunteer/:id/match-events', async (req, res) => {
    const volunteerID = parseInt(req.params.id);
    console.log(volunteerID);
    try {
        // Query the database for the volunteer
        const volunteerResult = await pool.query('SELECT * FROM UserProfile WHERE id = $1;', [volunteerID]);
        const volunteer = volunteerResult.rows[0];
        console.log(volunteer);
        if (!volunteer) {
            return res.status(404).json({ message: `Volunteer with ID ${volunteerID} not found.` });
        }

        // Fetch the events that match the volunteer's skills and availability
        const matchedEvents = await matchVolunteerToEvents(volunteer);

        return res.json({
            volunteerName: volunteer.fullName,
            matchingEvents: matchedEvents
        });
    } catch (error) {
        console.error(error.message);
        return res.status(500).json({ message: 'Internal server error.' });
    }
});

// Route to assign volunteer to an event and notify a volunteer
router.post('/volunteer/:volunteerID/notify', async (req, res) => {
    const volunteerID = parseInt(req.params.volunteerID);

    const eventID = req.body.eventId;
    const eventResult = await pool.query('SELECT * FROM EventDetails WHERE id = $1;', [eventID]);
    const event = eventResult.rows[0];

    if (!event) {
        return res.status(404).json({ message: `Event with ID ${eventID} not found.` });
    }

    const query = `
        SELECT up.fullName, up.email 
        FROM UserProfile up, VolunteerHistory vh 
        WHERE vh.userId = up.id AND vh.eventId = $1;
    `;
    const volunteersResult = await pool.query(query, [eventID]);
    const notifiedVolunteers = notifyVolunteersAssignedToEvent(volunteersResult.rows, event, 'assignment');

    return res.status(200).json({
        message: `Assignment notifications have been sent to all volunteers for the event: ${event.eventName}.`,
        notifiedVolunteers: notifiedVolunteers
    });
});

//route for notifications for event updates
router.post('/event/:eventId/update-notification', (req, res) => {
    const eventID = parseInt(req.params.eventId);
    const event = events.find(e => e.id === eventID);

    if (!event) {
        return res.status(404).json({ message: `Event with ID ${eventID} not found.` });
    }

    const notifiedVolunteers = notifyVolunteersAssignedToEvent(volunteers, event, 'update');

    return res.status(200).json({
        message: `Update notifications have been sent to all volunteers assigned to the event.`,
        notifiedVolunteers: notifiedVolunteers
    });
});

//route for notifications for event reminders
router.post('/event/:eventId/send-reminder', (req, res) => {
    const eventID = parseInt(req.params.eventId);
    const event = events.find(e => e.id === eventID);

    if (!event) {
        return res.status(404).json({ message: `Event with ID ${eventID} not found.` });
    }

    const notifiedVolunteers = notifyVolunteersAssignedToEvent(volunteers, event, 'reminder');

    return res.status(200).json({
        message: `Reminder notifications have been sent to all volunteers assigned to the event.`,
        notifiedVolunteers: notifiedVolunteers
    });
});

router.post('/updateProfile', async (req, res) => {
    const { userId, fullName, address1, address2, city, state, zipCode, skills, preferences, availability } = req.body;
  
    try {
      await pool.query('BEGIN');
  
      // Update the basic user profile
      const updateProfileQuery = `
        UPDATE UserProfile
        SET fullname = $1, address1 = $2, address2 = $3, city = $4, state = $5, zipcode = $6, preferences = $7
        WHERE id = $8;
      `;
      await pool.query(updateProfileQuery, [fullName, address1, address2, city, state, zipCode, preferences, userId]);
  
      // Update skills
      const deleteSkillsQuery = `DELETE FROM UserSkills WHERE userId = $1;`;
      await pool.query(deleteSkillsQuery, [userId]);
  
      const insertSkillsQuery = `
        INSERT INTO UserSkills (userId, skillId)
        VALUES ($1, (SELECT id FROM Skills WHERE skillName = $2))
      `;
      for (const skill of skills) {
        await pool.query(insertSkillsQuery, [userId, skill]);
      }
  
      // Update availability
      const deleteAvailabilityQuery = `DELETE FROM UserAvailability WHERE userId = $1;`;
      await pool.query(deleteAvailabilityQuery, [userId]);
  
      const insertAvailabilityQuery = `INSERT INTO UserAvailability (userId, availabilitydate) VALUES ($1, $2);`;
      for (const date of availability) {
        await pool.query(insertAvailabilityQuery, [userId, date]);
      }
  
      await pool.query('COMMIT'); 
      return res.json({ success: true, message: "Profile successfully updated." });
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('Error updating profile:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
  

  router.get('/userProfile/:userId', async (req, res) => {
    const { userId } = req.params;
  
    try {
      const query = `
        SELECT u.fullname, u.address1, u.address2, u.city, u.state, u.zipcode, 
               STRING_AGG(s.skillname, ',') AS skills, 
               u.preferences,
               ARRAY_AGG(ua.availabilitydate) AS availability
        FROM UserProfile AS u
        LEFT JOIN UserSkills AS us ON u.id = us.userId
        LEFT JOIN Skills AS s ON us.skillId = s.id
        LEFT JOIN UserAvailability AS ua ON u.id = ua.userId
        WHERE u.id = $1
        GROUP BY u.id;
      `;
      const result = await pool.query(query, [userId]);
  
      if (result.rows.length > 0) {
        res.json(result.rows[0]);
      } else {
        res.status(404).json({ error: 'User profile not found' });
      }
    } catch (error) {
      console.error('Error fetching profile:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  

module.exports = router

